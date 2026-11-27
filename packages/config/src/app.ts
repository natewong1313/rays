/**
 * Configure every Worker of a rays app, declared in Gleam with `rays/app`,
 * in `cloudflare.config.ts`.
 *
 * **Proof of concept.**
 *
 * {@link raysApp} compiles the project, calls `pub fn app()` in the app's
 * Gleam module, and makes a {@link raysWorker} configuration for each Worker
 * it adds. Every Worker gets a binding to every other Worker but the main
 * one, and to every Durable Object class of the app, named the way `rays/app` looks them up,
 * so the Gleam code never names a binding:
 *
 * ```ts
 * // cloudflare.config.ts
 * import { raysApp } from "@rays/config/app";
 * import { bindings, defineConfig } from "cf/config";
 *
 * const app = await raysApp({
 *   compatibilityDate: "2026-09-01",
 *   // Anything that isn't a resource of the app, by the app.Worker's name.
 *   workers: { front: { env: { GREETING: bindings.text("Hello") } } },
 * });
 *
 * export const auxiliaryWorkers = app.auxiliary;
 * export default defineConfig({ worker: app.main });
 * ```
 *
 * @module
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bindings, exports } from "cf/config";
import { compile } from "@rays/core/build";
import {
  raysWorker,
  type RaysWorkerConfig,
  type RaysWorkerModule,
} from "./cf.ts";

/** Configuration for one Worker that the app itself doesn't declare. */
export type AppWorkerExtras = Partial<Omit<RaysWorkerConfig, "name">>;

export interface RaysAppOptions {
  /** The directory holding `gleam.toml`. Defaults to the current directory. */
  root?: string;
  /**
   * The Gleam module with `pub fn app() -> App`. Defaults to the module
   * named after the Gleam package.
   */
  module?: string;
  /** Every Worker's compatibility date. */
  compatibilityDate: string;
  /** Every Worker's compatibility flags. */
  compatibilityFlags?: string[];
  /**
   * More configuration for some of the Workers, by the name in their
   * `app.Worker`, such as text bindings. Its `env` is merged with the
   * bindings the app makes.
   */
  workers?: Record<string, AppWorkerExtras>;
}

/** A Worker configuration made by {@link raysApp}. */
export type AppWorker = Omit<RaysWorkerConfig, "entrypoint"> & {
  entrypoint: RaysWorkerModule;
};

export interface RaysApp {
  /** The main Worker, for `defineConfig({ worker })`. */
  main: AppWorker;
  /** The other Workers, for the Vite plugin's `auxiliaryWorkers`. */
  auxiliary: AppWorker[];
  /** Every Worker, by the name in its `app.Worker`. */
  workers: Record<string, AppWorker>;
}

// What `rays/app`'s `describe` returns, as compiled Gleam values.
interface GleamList<T> {
  toArray(): T[];
}
interface GleamResult<T, E> {
  isOk(): boolean;
  0: T | E;
}
interface Description {
  name: string;
  main: string;
  workers: GleamList<[name: string, binding: string, entrypoint: unknown]>;
  classes: GleamList<[className: string, binding: string, host: string]>;
}

/**
 * Make the Cloudflare configuration of the Workers of a rays app.
 *
 * @throws {BuildError} If the project fails to compile.
 * @throws {TypeError} If the app module has no `app` function, the app has
 *   mistakes that `app.validate` finds, or a Worker's function isn't a
 *   `pub fn main()` of a module in the package.
 */
export async function raysApp(options: RaysAppOptions): Promise<RaysApp> {
  const root = path.resolve(options.root ?? ".");
  const project = await compile({ root });
  const packageDir = path.join(root, "build", "dev", "javascript");
  const appModule = options.module ?? project.packageName;

  const imported = await importModule(
    packageDir,
    project.packageName,
    appModule,
  );
  if (typeof imported.app !== "function") {
    throw new TypeError(
      `raysApp(): src/${appModule}.gleam has no pub fn app() -> App.`,
    );
  }
  // The same `rays/app` module instance the app's code was compiled against.
  const { describe } = await importModule(packageDir, "rays", "rays/app");
  const result = (
    describe as (app: unknown) => GleamResult<Description, GleamList<string>>
  )(imported.app());
  if (!result.isOk()) {
    const errors = (result[0] as GleamList<string>).toArray();
    throw new TypeError(
      `raysApp(): the app in src/${appModule}.gleam has mistakes:\n- ${errors.join("\n- ")}`,
    );
  }
  const app = result[0] as Description;
  const workers = app.workers.toArray();
  const classes = app.classes.toArray();
  const modules = await mainModules(root, packageDir, project.packageName);

  const deployedName = (ref: string) =>
    ref === app.main ? app.name : `${app.name}-${ref}`;
  const moduleOf = (ref: string, entrypoint: unknown) => {
    const module = modules.get(entrypoint);
    if (module === undefined) {
      throw new TypeError(
        `raysApp(): the Worker "${ref}" must be built by a pub fn main() in a module of the ${project.packageName} package.`,
      );
    }
    return module;
  };

  // The main Worker binds the others by their configuration, so the tools
  // that follow bindings, such as raysTestWorkers(), find them. They bind
  // each other by name, which keeps the configurations free of cycles.
  const configs: Record<string, AppWorker> = {};
  const target = (from: string, to: string) =>
    from === app.main && to !== app.main ? configs[to] : deployedName(to);

  const make = (ref: string, entrypoint: unknown) => {
    const extras = options.workers?.[ref] ?? {};
    const env: Record<string, unknown> = {};
    // The main Worker is the app's front door, which no other Worker binds.
    for (const [other, binding] of workers) {
      if (other !== ref && other !== app.main) {
        env[binding] = bindings.worker({ worker: target(ref, other) as never });
      }
    }
    for (const [className, binding, host] of classes) {
      env[binding] = bindings.durableObject({
        worker: target(ref, host) as never,
        exportName: className as never,
      });
    }
    const hosted = Object.fromEntries(
      classes
        .filter(([, , host]) => host === ref)
        .map(([className]) => [
          className,
          exports.durableObject({ storage: "sqlite" }),
        ]),
    );
    configs[ref] = raysWorker(
      {
        ...extras,
        name: deployedName(ref),
        compatibilityDate: options.compatibilityDate,
        ...(options.compatibilityFlags && {
          compatibilityFlags: options.compatibilityFlags,
        }),
        ...(Object.keys(hosted).length > 0 && {
          exports: { ...hosted, ...(extras.exports as object) },
        }),
        env: { ...env, ...(extras.env as object) },
      } as RaysWorkerConfig,
      { module: moduleOf(ref, entrypoint) },
    ) as AppWorker;
  };

  // The main Worker last, as it refers to the others' configurations.
  for (const [ref, , entrypoint] of workers) {
    if (ref !== app.main) make(ref, entrypoint);
  }
  const [, , mainEntrypoint] = workers.find(([ref]) => ref === app.main)!;
  make(app.main, mainEntrypoint);

  return {
    main: configs[app.main]!,
    auxiliary: workers
      .filter(([ref]) => ref !== app.main)
      .map(([ref]) => configs[ref]!),
    workers: configs,
  };
}

async function importModule(
  packageDir: string,
  packageName: string,
  module: string,
): Promise<Record<string, unknown>> {
  const file = path.join(packageDir, packageName, `${module}.mjs`);
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

// The Gleam module of each `main` function in the package, by the function,
// so a Worker of the app is found by the function that builds it. Only the
// modules in `src/` are imported: Gleam leaves a deleted module's compiled
// file in the build directory, where it may no longer load.
async function mainModules(
  root: string,
  packageDir: string,
  packageName: string,
): Promise<Map<unknown, string>> {
  const src = path.join(root, "src");
  const found = new Map<unknown, string>();
  for (const entry of await readdir(src, { recursive: true })) {
    if (!entry.endsWith(".gleam")) continue;
    const module = entry.slice(0, -".gleam".length).split(path.sep).join("/");
    const { main } = await importModule(packageDir, packageName, module);
    if (typeof main === "function") found.set(main, module);
  }
  return found;
}
