/**
 * Running the project's own Wrangler, from its node_modules.
 *
 * @module
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { CliError } from "./managed.ts";

/**
 * The Wrangler executable installed for the project in `root`, looking in
 * each enclosing node_modules as Node.js does.
 *
 * @throws {CliError} If Wrangler is not installed.
 */
export function findWrangler(root: string): string {
  const name = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  for (let directory = path.resolve(root); ;) {
    const candidate = path.join(directory, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new CliError(
    "Wrangler is not installed in this project. Install it with `npm install --save-dev wrangler`, or your package manager's equivalent.",
  );
}

/** Start Wrangler in `root` with `args`, sharing this terminal. */
export function startWrangler(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const wrangler = findWrangler(root);
  return spawn(wrangler, args, {
    cwd: root,
    env,
    stdio: "inherit",
    // `.cmd` files only run through the shell on Windows.
    shell: process.platform === "win32",
  });
}

/** Run Wrangler in `root` with `args`, resolving to its exit code. */
export function runWrangler(root: string, args: string[]): Promise<number> {
  return exitCode(startWrangler(root, args));
}

/** The exit code of a child process, 1 if a signal stopped it. */
export function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * `args` with `-c <config>` for each configuration, before any `--` so that
 * Wrangler reads them as its own options.
 */
export function withConfigs(args: string[], configs: string[]): string[] {
  const flags = configs.flatMap((config) => ["-c", config]);
  const end = args.indexOf("--");
  return end === -1
    ? [...args, ...flags]
    : [...args.slice(0, end), ...flags, ...args.slice(end)];
}

/** Whether `args` already set the option `name`, as `--name` or `--name=`. */
export function hasOption(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** The Cloudflare environment that `args` select, if any. */
export function selectedEnvironment(args: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === "--") break;
    if (arg === "--env" || arg === "-e") return args[index + 1];
    if (arg.startsWith("--env=")) return arg.slice("--env=".length);
  }
  return process.env["CLOUDFLARE_ENV"] || undefined;
}

/**
 * The local variable files Wrangler would load from the project in `root`,
 * least specific first.
 *
 * Wrangler reads them from the directory of its configuration file, which for
 * a managed project is `.rays/`. Passing them with `--env-file` keeps them in
 * the project root. As Wrangler does, a `.dev.vars.<env>` file replaces
 * `.dev.vars`, `.dev.vars` replaces the `.env` files, and the `.env` files
 * are merged, with the most specific winning.
 *
 * @returns Absolute paths, since Wrangler resolves relative ones against the
 *   configuration file's directory.
 */
export function devVarsFiles(
  root: string,
  environment: string | undefined,
): string[] {
  const existing = (name: string) => {
    const file = path.join(root, name);
    return existsSync(file) ? [file] : [];
  };

  if (environment !== undefined) {
    const specific = existing(`.dev.vars.${environment}`);
    if (specific.length > 0) return specific;
  }
  const devVars = existing(".dev.vars");
  if (devVars.length > 0) return devVars;

  if (process.env["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] === "false") {
    return [];
  }
  return [
    ".env",
    ...(environment === undefined ? [] : [`.env.${environment}`]),
    ".env.local",
    ...(environment === undefined ? [] : [`.env.${environment}.local`]),
  ].flatMap(existing);
}
