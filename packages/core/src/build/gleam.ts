// Running Gleam, and reading what it reports about a project.

import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BuildError } from "./error.ts";
import { isErrorCode } from "./files.ts";
import type { ModuleInterface } from "./package-interface.ts";

/** Read the package name from the `gleam.toml` in `root`. */
export async function readPackageName(root: string): Promise<string> {
  const file = path.join(root, "gleam.toml");
  let toml: string;
  try {
    toml = await readFile(file, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) throw noGleamToml(root);
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

// Run Gleam and return its stdout. Its stderr, where its progress and errors
// go, is passed through (see `CompileOptions.output`), or with `"quiet"`
// printed only if it fails.
export function runGleam(
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
    child.on("error", (error) => reject(notFound(error, gleam)));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const printed = Buffer.concat(stderr).toString("utf8");
      if (output === "quiet") process.stderr.write(printed);
      reject(failed(args, signal, printed));
    });
  });
}

/** The error for a `root` without a `gleam.toml`. */
export function noGleamToml(root: string): BuildError {
  return new BuildError(
    `No gleam.toml in ${root}. Run rays from the directory that holds gleam.toml and package.json.`,
  );
}

/** The Gleam binary to run: the one given, `RAYS_GLEAM_BIN`, or `gleam`. */
export function gleamBinary(gleam: string | undefined): string {
  return gleam ?? process.env["RAYS_GLEAM_BIN"] ?? "gleam";
}

// The error for a failure to start Gleam: a BuildError if it isn't
// installed, or else the error itself.
function notFound(error: unknown, gleam: string): unknown {
  return isErrorCode(error, "ENOENT")
    ? new BuildError(
        `Could not find Gleam at "${gleam}". Install Gleam, or set RAYS_GLEAM_BIN to its path.`,
      )
    : error;
}

function failed(
  args: readonly string[],
  signal: NodeJS.Signals | null,
  printed: string,
): BuildError {
  const command = `gleam ${args[0]}`;
  return new BuildError(
    signal === null
      ? `${command} failed.`
      : `${command} was stopped by ${signal}.`,
    printed,
  );
}

type Interface = Record<string, ModuleInterface | undefined>;

const EXPORT_INTERFACE = ["export", "package-interface"] as const;

function parseInterface(json: string): Interface {
  return (JSON.parse(json) as { modules: Record<string, ModuleInterface> })
    .modules;
}

/** The types of the project's modules, by module name. */
export async function readInterface(
  gleam: string,
  root: string,
): Promise<Interface> {
  return parseInterface(
    await runGleam(gleam, root, EXPORT_INTERFACE, { output: "quiet" }),
  );
}

/**
 * {@link readInterface}, synchronously, for configuration that is evaluated
 * synchronously. What Gleam prints is kept in the error, not printed.
 */
export function readInterfaceSync(gleam: string, root: string): Interface {
  let json: string;
  try {
    json = execFileSync(gleam, EXPORT_INTERFACE, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) throw notFound(error, gleam);
    const { stderr, signal } = error as {
      stderr?: unknown;
      signal?: NodeJS.Signals | null;
    };
    throw failed(
      EXPORT_INTERFACE,
      signal ?? null,
      typeof stderr === "string" ? stderr : "",
    );
  }
  return parseInterface(json);
}
