/**
 * Building a Gleam project into Cloudflare Worker entry modules.
 *
 * Shared by the `rays build` command and the build integrations that use it.
 * Uses only `node:` modules, so it runs in both Node.js and Bun.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** The directory, next to `gleam.toml`, that `rays build` writes into. */
export const OUTPUT_DIR = ".rays";

/** A build failure with a message meant for the developer. */
export class BuildError extends Error {
  override name = "BuildError";
}

export interface BuildOptions {
  /** The directory holding `gleam.toml`. */
  root: string;
  /**
   * The Gleam modules whose `main()` builds a Worker, such as `"app"` or
   * `"app/admin"`. Defaults to the module named after the Gleam package.
   */
  modules?: readonly string[];
  /** The `gleam` executable. Defaults to `$RAYS_GLEAM_BIN`, then `gleam`. */
  gleam?: string;
}

/** An entry module written by {@link build}. */
export interface Entry {
  /** The Gleam module the Worker comes from. */
  module: string;
  /** The absolute path of the entry module. */
  path: string;
  /** Whether this build changed the file. Unchanged files are not touched. */
  changed: boolean;
}

/**
 * Compile the Gleam project to JavaScript and write one entry module per
 * Worker to `.rays/<module>.entry.ts`.
 *
 * Every Worker module is checked before any entry is written, so a failed
 * build leaves the last good entries in place.
 *
 * @throws {BuildError} If the project or a module is not usable, or Gleam
 *   fails to compile it. Gleam's own errors go to stderr as it prints them.
 */
export async function build(options: BuildOptions): Promise<Entry[]> {
  const root = path.resolve(options.root);
  const packageName = await readPackageName(root);
  const modules = options.modules?.length ? options.modules : [packageName];
  for (const module of modules) checkModuleName(module);

  const gleam = options.gleam ?? process.env["RAYS_GLEAM_BIN"] ?? "gleam";
  await runGleam(gleam, root, ["build", "--target", "javascript"]);
  const modulesInterface = await readInterface(gleam, root);

  const outputs = [];
  for (const module of modules) {
    checkWorkerModule(module, modulesInterface[module]);
    const compiled = path.join(
      root,
      "build",
      "dev",
      "javascript",
      packageName,
      `${module}.mjs`,
    );
    const entry = path.join(root, OUTPUT_DIR, `${module}.entry.ts`);
    outputs.push({
      module,
      path: entry,
      source: entrySource(module, entry, compiled),
    });
  }

  await mkdir(path.join(root, OUTPUT_DIR), { recursive: true });
  await writeIfChanged(path.join(root, OUTPUT_DIR, ".gitignore"), "*\n");

  const entries = [];
  for (const { module, path: entry, source } of outputs) {
    const changed = await writeIfChanged(entry, source);
    entries.push({ module, path: entry, changed });
  }
  return entries;
}

/** Read the package name from the `gleam.toml` in `root`. */
export async function readPackageName(root: string): Promise<string> {
  const file = path.join(root, "gleam.toml");
  let toml: string;
  try {
    toml = await readFile(file, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      throw new BuildError(
        `No gleam.toml in ${root}. Run rays from the directory that holds gleam.toml and package.json.`,
      );
    }
    throw error;
  }

  // `name` is a top-level key, so it comes before the first table.
  const topLevel = toml.split(/^\s*\[/m)[0] ?? "";
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(topLevel)?.[1];
  if (name === undefined) {
    throw new BuildError(`${file} has no name.`);
  }
  return name;
}

function checkModuleName(module: string): void {
  if (!/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)*$/.test(module)) {
    throw new BuildError(
      `"${module}" is not a Gleam module name. Module names look like "app" or "app/admin".`,
    );
  }
}

// Run Gleam and return its stdout. Its stderr, where its progress and errors
// go, is passed through as it is written, or with `quiet`, only if it fails.
function runGleam(
  gleam: string,
  root: string,
  args: readonly string[],
  { quiet = false } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gleam, args, {
      cwd: root,
      stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (isErrorCode(error, "ENOENT")) {
        reject(
          new BuildError(
            `Could not find Gleam at "${gleam}". Install Gleam, or set RAYS_GLEAM_BIN to its path.`,
          ),
        );
      } else {
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      const command = `gleam ${args[0]}`;
      if (code !== 0) process.stderr.write(Buffer.concat(stderr));
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else if (signal !== null) {
        reject(new BuildError(`${command} was stopped by ${signal}.`));
      } else reject(new BuildError(`${command} failed.`));
    });
  });
}

// The parts of `gleam export package-interface` that rays reads.
interface ModuleInterface {
  functions: Record<
    string,
    {
      parameters: unknown[];
      return: TypeInterface;
      implementations: { "can-run-on-javascript": boolean };
    }
  >;
}

type TypeInterface =
  | { kind: "named"; name: string; package: string; module: string }
  | { kind: "variable" | "tuple" | "fn" };

async function readInterface(
  gleam: string,
  root: string,
): Promise<Record<string, ModuleInterface | undefined>> {
  const json = await runGleam(gleam, root, ["export", "package-interface"], {
    quiet: true,
  });
  return (JSON.parse(json) as { modules: Record<string, ModuleInterface> })
    .modules;
}

// Check that a module has `pub fn main() -> workers.Worker`, using the types
// Gleam reports, so mistakes show up here rather than when the Worker runs.
function checkWorkerModule(
  module: string,
  moduleInterface: ModuleInterface | undefined,
): void {
  const source = `src/${module}.gleam`;
  if (moduleInterface === undefined) {
    throw new BuildError(
      `There is no Gleam module "${module}": ${source} does not exist.`,
    );
  }

  const main = moduleInterface.functions["main"];
  if (main === undefined) {
    throw new BuildError(
      `${source} has no public main function. Add \`pub fn main() -> workers.Worker\` that returns workers.new(...).`,
    );
  }
  if (main.parameters.length > 0) {
    throw new BuildError(`main in ${source} must take no arguments.`);
  }

  const returned = main.return;
  if (
    returned.kind !== "named" ||
    returned.package !== "rays" ||
    returned.module !== "rays/workers" ||
    returned.name !== "Worker"
  ) {
    throw new BuildError(
      `main in ${source} must return a workers.Worker, but it returns ${describeType(returned)}.`,
    );
  }
  if (!main.implementations["can-run-on-javascript"]) {
    throw new BuildError(`main in ${source} can't run on JavaScript.`);
  }
}

function describeType(type: TypeInterface): string {
  switch (type.kind) {
    case "named":
      return type.module === "gleam"
        ? type.name
        : `${type.module}.${type.name}`;
    case "fn":
      return "a function";
    case "tuple":
      return "a tuple";
    case "variable":
      return "a type variable";
  }
}

// The entry module is self-contained: it doesn't import @rays/cloudflare, so
// it works in projects that only depend on Wrangler.
function entrySource(module: string, entry: string, compiled: string): string {
  let specifier = path
    .relative(path.dirname(entry), compiled)
    .split(path.sep)
    .join("/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;

  return `// Generated by \`rays build\` from src/${module}.gleam. Do not edit: it is
// rewritten on every build.
import { main } from ${JSON.stringify(specifier)};

const worker: unknown = main();

if (
  typeof worker !== "object" ||
  worker === null ||
  (worker as Record<symbol, unknown>)[Symbol.for("rays.worker")] !== true
) {
  throw new TypeError(
    ${JSON.stringify(`main in src/${module}.gleam must return a rays Worker, made with workers.new.`)},
  );
}

// Typed without the Workers runtime types, which the project may not use.
export default worker as {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
};
`;
}

// Write through a temporary file, so a watcher never sees half a file, and
// leave unchanged files alone, so it doesn't rebuild for nothing.
async function writeIfChanged(
  file: string,
  contents: string,
): Promise<boolean> {
  try {
    if ((await readFile(file, "utf8")) === contents) return false;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
  return true;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}
