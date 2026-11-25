/**
 * Configure a rays Worker in `cloudflare.config.ts`.
 *
 * `raysWorker()` takes the same Worker configuration as `defineWorker()` from
 * `cf/config`, without `entrypoint`, and sets the entrypoint to the rays
 * Worker. The project builds with Vite, with the `rays()` plugin from
 * `@rays/config/vite` before Cloudflare's plugin, which builds the
 * Worker from Gleam.
 *
 * ```ts
 * // cloudflare.config.ts
 * import { bindings, defineConfig } from "cf/config";
 * import { raysWorker } from "@rays/config/cf";
 *
 * export default defineConfig({
 *   worker: raysWorker({
 *     name: "my-app",
 *     compatibilityDate: "2026-09-01",
 *     env: { GREETING: bindings.text("Hello") },
 *   }),
 * });
 * ```
 *
 * Like `defineWorker()`, it also takes a function of the config context, or
 * a promise, and its result can be exported for other Workers' bindings.
 *
 * It also declares the project's Durable Object classes, from
 * `rays/durable_object`, in the Worker's `exports`, with SQLite storage. To
 * declare only some of them, or none, list them with the `durableObjects`
 * option; an entry the configuration's own `exports` has for a class is
 * kept as it is.
 *
 * @module
 */

import type { ConfigContext, WorkerConfig } from "cf/config";
import {
  isModuleName,
  notAModuleName,
  readDurableObjectClasses,
} from "@rays/core/build";

/** A Worker configuration for {@link raysWorker}: everything but `entrypoint`. */
export type RaysWorkerConfig = Omit<WorkerConfig, "entrypoint"> & {
  /** Set by {@link raysWorker}. Choose the Gleam module with its `module` option. */
  entrypoint?: never;
};

/** The forms {@link raysWorker} accepts, as `defineWorker()` does. */
export type RaysWorkerInput =
  | RaysWorkerConfig
  | Promise<RaysWorkerConfig>
  | ((ctx: ConfigContext) => RaysWorkerConfig | Promise<RaysWorkerConfig>);

/** The entrypoint {@link raysWorker} sets: a module of the `rays()` plugin. */
export type RaysEntrypoint =
  "virtual:rays/worker" | `virtual:rays/worker/${string}`;

/**
 * The type of a rays Worker module: a default export with `fetch`.
 *
 * {@link raysWorker} types `entrypoint` as this module, the way a `cf-worker`
 * import is typed, so `cf/config` infers the main module for `exports` from
 * `cloudflare:workers`. At runtime `entrypoint` is the module's
 * {@link RaysEntrypoint} specifier, just as a `cf-worker` import is a
 * reference to its module rather than the module itself.
 */
export type RaysWorkerModule = {
  default: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
};

/** The `exports` entry {@link raysWorker} declares for a Durable Object class. */
export type RaysDurableObjectExport = {
  type: "durable-object";
  storage: "sqlite";
};

const DURABLE_OBJECT_EXPORT = {
  type: "durable-object",
  storage: "sqlite",
} as const satisfies RaysDurableObjectExport;

/**
 * `T` with the rays entrypoint, keeping its form, and the `exports` of the
 * Durable Object classes `Classes`. When they aren't listed, any class may
 * be declared.
 */
export type WithRaysEntrypoint<T, Classes extends string = string> =
  T extends Promise<infer Config>
    ? Promise<WithRaysEntrypoint<Config, Classes>>
    : T extends (ctx: ConfigContext) => infer Result
      ? (ctx: ConfigContext) => WithRaysEntrypoint<Result, Classes>
      : T & { entrypoint: RaysWorkerModule } & RaysExports<T, Classes>;

// The `exports` raysWorker adds to a configuration `T`, besides its own.
// Classes that aren't listed are only known when the configuration is
// evaluated.
type RaysExports<T, Classes extends string> = string extends Classes
  ? T extends { exports: object }
    ? unknown
    : { exports?: Record<string, RaysDurableObjectExport> }
  : [Exclude<Classes, keyof OwnExports<T>>] extends [never]
    ? unknown
    : {
        exports: {
          [
            Class in Exclude<Classes, keyof OwnExports<T>>
          ]: RaysDurableObjectExport;
        };
      };

type OwnExports<T> = T extends { exports: infer Own extends object } ? Own : {};

export interface RaysWorkerOptions<Classes extends string = string> {
  /**
   * The Gleam module whose `pub fn main()` builds the Worker, such as
   * `"app/admin"`. Defaults to the one the `rays()` plugin uses for
   * `virtual:rays/worker`: the module named after the Gleam package, unless
   * the plugin's `module` option says otherwise.
   */
  module?: string;
  /**
   * The Durable Object classes to declare in the Worker's `exports`, such as
   * `["ChatRoom"]`, or `[]` for none. Every class rays builds is exported
   * from every Worker's entry module, but only declared classes are created.
   *
   * Defaults to every class in the project, which Gleam reads each time the
   * configuration is evaluated. That compiles the project, so the first
   * evaluation takes as long as a build; once it is built, it is quick. In a
   * project with several Workers, list the ones each Worker declares. Listed classes are also typed, so
   * `bindings.durableObject()` accepts them as its `exportName`.
   */
  durableObjects?: readonly Classes[];
  /**
   * The directory holding `gleam.toml`, where the project's Durable Object
   * classes are read from when `durableObjects` doesn't list them. Defaults
   * to the current directory.
   */
  root?: string;
}

/**
 * Configure a Worker built by rays from Gleam.
 *
 * @param config The Worker's configuration, as for `defineWorker()`, without
 *   `entrypoint`.
 * @throws {TypeError} If the configuration sets `entrypoint`, or `module` is
 *   not a Gleam module name.
 * @throws {BuildError} If the Durable Object classes are read from the
 *   project, and `root` has no `gleam.toml`, or the project fails to
 *   compile.
 */
export function raysWorker<
  const T extends RaysWorkerInput,
  const Classes extends string = string,
>(
  config: T,
  options: RaysWorkerOptions<Classes> = {},
): WithRaysEntrypoint<T, Classes> {
  const entrypoint = entrypointFor(options.module);
  // Read when the configuration is resolved, so a configuration that is
  // evaluated again sees the classes as they are then.
  const durableObjects = () =>
    options.durableObjects ??
    readDurableObjectClasses({ root: options.root ?? process.cwd() });
  return withEntrypoint(
    config,
    entrypoint,
    durableObjects,
  ) as WithRaysEntrypoint<T, Classes>;
}

function entrypointFor(module: string | undefined): RaysEntrypoint {
  if (module === undefined) return "virtual:rays/worker";
  if (!isModuleName(module)) {
    throw new TypeError(`raysWorker(): ${notAModuleName(module)}`);
  }
  return `virtual:rays/worker/${module}`;
}

function withEntrypoint(
  config: unknown,
  entrypoint: RaysEntrypoint,
  durableObjects: () => readonly string[],
): unknown {
  if (typeof config === "function") {
    return (ctx: ConfigContext) =>
      withEntrypoint(config(ctx), entrypoint, durableObjects);
  }
  if (config instanceof Promise) {
    return config.then((resolved) =>
      withEntrypoint(resolved, entrypoint, durableObjects),
    );
  }
  if (typeof config !== "object" || config === null) {
    throw new TypeError(
      "raysWorker() expects a Worker configuration object, a promise of one, or a function that returns one.",
    );
  }
  if ("entrypoint" in config) {
    throw new TypeError(
      `raysWorker() sets the entrypoint to the rays Worker, so the configuration can't set one. Remove entrypoint, or use { module } to choose the Gleam module.`,
    );
  }
  return withExports({ ...config, entrypoint }, durableObjects());
}

// Declare the classes the configuration's own `exports` doesn't.
function withExports(
  config: Record<string, unknown>,
  classes: readonly string[],
): Record<string, unknown> {
  const own = (config.exports ?? {}) as Record<string, unknown>;
  const added = classes.filter((name) => !Object.hasOwn(own, name));
  if (added.length === 0) return config;
  const exports = Object.fromEntries(
    added.map((name) => [name, { ...DURABLE_OBJECT_EXPORT }]),
  );
  return { ...config, exports: { ...exports, ...own } };
}
