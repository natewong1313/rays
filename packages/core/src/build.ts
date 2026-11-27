/**
 * Building a Gleam project into Cloudflare Worker entry modules.
 *
 * This is the API for build integrations: the `rays build` command from
 * `@rays/cli`, and the `rays()` Vite plugin and `raysTestWorkers()` from
 * `@rays/config`, use it. Most projects use one of those instead of calling
 * it directly. It uses only `node:` modules, so
 * it runs in both Node.js and Bun.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { entrySource } from "./build/entry.ts";
import { relativeSpecifier, writeIfChanged } from "./build/files.ts";
import {
  gleamBinary,
  readInterface,
  readPackageName,
  runGleam,
} from "./build/gleam.ts";
import {
  buildRpc,
  type DurableObjects,
  type WorkerRpc,
} from "./build/rpc/build.ts";
import { checkModuleName, checkWorkerModule } from "./build/worker-module.ts";

export { BuildError } from "./build/error.ts";
export { entrySource, type EntryOptions } from "./build/entry.ts";
export { readPackageName } from "./build/gleam.ts";
export { isModuleName, notAModuleName } from "./build/module-name.ts";
export {
  selectDurableObjects,
  type DurableObjectClass,
} from "./build/durable-object.ts";
export type {
  BuiltDurableObjectClass,
  DurableObjects,
  RpcMethod,
  WorkerRpc,
} from "./build/rpc/build.ts";

/** The directory, next to `gleam.toml`, that `rays build` writes into. */
const OUTPUT_DIR = ".rays";

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
   * The project's Workers RPC methods, for `rays/worker_rpc`, or `undefined`
   * if it has none. A Worker's entry module then serves them.
   */
  rpc: WorkerRpc | undefined;
  /**
   * The project's Durable Object classes, for `rays/durable_object`, or
   * `undefined` if it has none. A Worker's entry module exports them all,
   * or the ones its configuration declares, with
   * {@link selectDurableObjects}.
   */
  durableObjects: DurableObjects | undefined;
  /**
   * The absolute path of the compiled JavaScript for a Worker module.
   *
   * @throws {BuildError} If the module doesn't exist, or has no
   *   `pub fn main() -> worker.Worker`.
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
  const gleam = gleamBinary(options.gleam);
  await runGleam(gleam, root, ["build", "--target", "javascript"], {
    output: options.output ?? "inherit",
  });
  const modules = await readInterface(gleam, root);
  const { rpc, durableObjects } = await buildRpc({
    root,
    packageName,
    modules,
  });

  return {
    root,
    packageName,
    rpc,
    durableObjects,
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
    return {
      module,
      path: entry,
      source: entrySource(module, compiled, {
        generator: "rays build",
        typescript: true,
        rpc: project.rpc,
        durableObjects: project.durableObjects,
        specifier: (file) => relativeSpecifier(path.dirname(entry), file),
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
