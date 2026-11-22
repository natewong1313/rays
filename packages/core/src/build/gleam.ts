// Running Gleam, and reading what it reports about a project.

import { spawn } from "node:child_process";
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

/** The types of the project's modules, by module name. */
export async function readInterface(
  gleam: string,
  root: string,
): Promise<Record<string, ModuleInterface | undefined>> {
  const json = await runGleam(gleam, root, ["export", "package-interface"], {
    output: "quiet",
  });
  return (JSON.parse(json) as { modules: Record<string, ModuleInterface> })
    .modules;
}
