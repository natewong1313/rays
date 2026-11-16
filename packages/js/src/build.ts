/**
 * Building a Gleam project into Cloudflare Worker entry modules.
 *
 * This is the API for build integrations: the `rays build` command from
 * `@rays/cli` and the `rays()` Vite plugin both use it. Most projects use one
 * of those instead of calling it directly. It uses only `node:` modules, so
 * it runs in both Node.js and Bun.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isModuleName, notAModuleName } from "./module-name.ts";

/** The directory, next to `gleam.toml`, that `rays build` writes into. */
const OUTPUT_DIR = ".rays";

/** A build failure with a message meant for the developer. */
export class BuildError extends Error {
  override name = "BuildError";

  /** What Gleam printed, if the failure came from Gleam. */
  readonly output: string;

  constructor(message: string, output = "") {
    super(message);
    this.output = output;
  }
}

export interface CompileOptions {
  /** The directory holding `gleam.toml`. */
  root: string;
  /** The `gleam` executable. Defaults to `$RAYS_GLEAM_BIN`, then `gleam`. */
  gleam?: string;
  /**
   * Where Gleam's output goes. `"inherit"` (the default) gives it the
   * terminal, keeping its colours. `"tee"` copies it to stderr and also keeps
   * it, so a failure's {@link BuildError.output} holds Gleam's errors.
   */
  output?: "inherit" | "tee";
}

export interface BuildOptions extends CompileOptions {
  /**
   * The Gleam modules whose `main()` builds a Worker, such as `"app"` or
   * `"app/admin"`. Defaults to the module named after the Gleam package.
   */
  modules?: readonly string[];
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

/** A Gleam project, compiled to JavaScript by {@link compile}. */
export interface Project {
  /** The absolute path of the directory holding `gleam.toml`. */
  root: string;
  /** The Gleam package's name, which is also its default Worker module. */
  packageName: string;
  /**
   * The absolute path of the compiled JavaScript for a Worker module.
   *
   * @throws {BuildError} If the module doesn't exist, or has no
   *   `pub fn main() -> workers.Worker`.
   */
  workerModule(module: string): string;
}

/**
 * Compile the Gleam project to JavaScript, and read the types of its modules
 * so that its Worker modules can be checked.
 *
 * @throws {BuildError} If the project is not usable or fails to compile.
 */
export async function compile(options: CompileOptions): Promise<Project> {
  const root = path.resolve(options.root);
  const packageName = await readPackageName(root);
  const gleam = options.gleam ?? process.env["RAYS_GLEAM_BIN"] ?? "gleam";
  await runGleam(gleam, root, ["build", "--target", "javascript"], {
    output: options.output ?? "inherit",
  });
  const modules = await readInterface(gleam, root);

  return {
    root,
    packageName,
    workerModule(module) {
      checkModuleName(module);
      checkWorkerModule(module, modules[module]);
      return path.join(
        root,
        "build",
        "dev",
        "javascript",
        packageName,
        `${module}.mjs`,
      );
    },
  };
}

/**
 * Compile the Gleam project to JavaScript and write one entry module per
 * Worker to `.rays/<module>.entry.ts`.
 *
 * Every Worker module is checked before any entry is written, so a failed
 * build leaves the last good entries in place.
 *
 * @throws {BuildError} If the project or a module is not usable, or Gleam
 *   fails to compile it.
 */
export async function build(options: BuildOptions): Promise<Entry[]> {
  const root = path.resolve(options.root);
  // Check the names first, so a typo doesn't wait for a compile.
  for (const module of options.modules ?? []) checkModuleName(module);

  const project = await compile({ ...options, root });
  const modules = options.modules?.length
    ? options.modules
    : [project.packageName];

  const outputs = modules.map((module) => {
    const compiled = project.workerModule(module);
    const entry = path.join(root, OUTPUT_DIR, `${module}.entry.ts`);
    const specifier = relativeSpecifier(path.dirname(entry), compiled);
    return {
      module,
      path: entry,
      source: entrySource(module, specifier, {
        generator: "rays build",
        typescript: true,
      }),
    };
  });

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
async function readPackageName(root: string): Promise<string> {
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
  if (!isModuleName(module)) throw new BuildError(notAModuleName(module));
}

// Run Gleam and return its stdout. Its stderr, where its progress and errors
// go, is passed through (see `CompileOptions.output`), or with `"quiet"`
// printed only if it fails.
function runGleam(
  gleam: string,
  root: string,
  args: readonly string[],
  { output }: { output: "inherit" | "tee" | "quiet" },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gleam, args, {
      cwd: root,
      stdio: ["ignore", "pipe", output === "inherit" ? "inherit" : "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (output === "tee") process.stderr.write(chunk);
    });
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
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const printed = Buffer.concat(stderr).toString("utf8");
      if (output === "quiet") process.stderr.write(printed);
      const command = `gleam ${args[0]}`;
      reject(
        new BuildError(
          signal === null
            ? `${command} failed.`
            : `${command} was stopped by ${signal}.`,
          printed,
        ),
      );
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
    output: "quiet",
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

/** An import specifier for `file`, relative to the directory `from`. */
function relativeSpecifier(from: string, file: string): string {
  const specifier = path.relative(from, file).split(path.sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

/**
 * The source of an entry module, which exports the Worker returned by `main`
 * in the compiled Gleam module that `specifier` imports.
 *
 * The module is self-contained: it doesn't import `@rays/cloudflare`, so it
 * works in projects that only depend on Wrangler.
 */
export function entrySource(
  module: string,
  specifier: string,
  { generator, typescript }: { generator: string; typescript: boolean },
): string {
  const as = (type: string) => (typescript ? ` as ${type}` : "");
  const message = `main in src/${module}.gleam must return a rays Worker, made with workers.new.`;
  return `// Generated by ${generator} from src/${module}.gleam. Do not edit: it is
// rewritten on every build.
${
  typescript
    ? `// Gleam only declares types with typescript_declarations in gleam.toml,
// and main's type isn't needed: the Worker is checked and typed below.
// @ts-ignore
`
    : ""
}import { main } from ${JSON.stringify(specifier)};

const worker${typescript ? ": unknown" : ""} = main();

if (
  typeof worker !== "object" ||
  worker === null ||
  (worker${as("Record<symbol, unknown>")})[Symbol.for("rays.worker")] !== true
) {
  throw new TypeError(${JSON.stringify(message)});
}
${
  typescript
    ? `
// Typed without the Workers runtime types, which the project may not use.
export default worker as {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
};
`
    : `
export default worker;
`
}`;
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
