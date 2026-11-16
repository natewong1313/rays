/**
 * Configure a rays Worker in `cloudflare.config.ts`.
 *
 * `raysWorker()` takes the same Worker configuration as `defineWorker()` from
 * `cf/config`, without `entrypoint`, and sets the entrypoint to the rays
 * Worker. The project builds with Vite, with the `rays()` plugin from
 * `@rays/core/vite` before Cloudflare's plugin, which builds the
 * Worker from Gleam.
 *
 * ```ts
 * // cloudflare.config.ts
 * import { bindings, defineConfig } from "cf/config";
 * import { raysWorker } from "@rays/core/cf";
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
 * @module
 */

import type { ConfigContext, WorkerConfig } from "cf/config";
import { isModuleName, notAModuleName } from "./module-name.ts";

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

/** `T` with the rays entrypoint, keeping its form. */
export type WithRaysEntrypoint<T> =
  T extends Promise<infer Config>
    ? Promise<WithRaysEntrypoint<Config>>
    : T extends (ctx: ConfigContext) => infer Result
      ? (ctx: ConfigContext) => WithRaysEntrypoint<Result>
      : T & { entrypoint: RaysWorkerModule };

export interface RaysWorkerOptions {
  /**
   * The Gleam module whose `pub fn main()` builds the Worker, such as
   * `"app/admin"`. Defaults to the one the `rays()` plugin uses for
   * `virtual:rays/worker`: the module named after the Gleam package, unless
   * the plugin's `module` option says otherwise.
   */
  module?: string;
}

/**
 * Configure a Worker built by rays from Gleam.
 *
 * @param config The Worker's configuration, as for `defineWorker()`, without
 *   `entrypoint`.
 * @throws {TypeError} If the configuration sets `entrypoint`, or `module` is
 *   not a Gleam module name.
 */
export function raysWorker<const T extends RaysWorkerInput>(
  config: T,
  options: RaysWorkerOptions = {},
): WithRaysEntrypoint<T> {
  const entrypoint = entrypointFor(options.module);
  return withEntrypoint(config, entrypoint) as WithRaysEntrypoint<T>;
}

function entrypointFor(module: string | undefined): RaysEntrypoint {
  if (module === undefined) return "virtual:rays/worker";
  if (!isModuleName(module)) {
    throw new TypeError(`raysWorker(): ${notAModuleName(module)}`);
  }
  return `virtual:rays/worker/${module}`;
}

function withEntrypoint(config: unknown, entrypoint: RaysEntrypoint): unknown {
  if (typeof config === "function") {
    return (ctx: ConfigContext) => withEntrypoint(config(ctx), entrypoint);
  }
  if (config instanceof Promise) {
    return config.then((resolved) => withEntrypoint(resolved, entrypoint));
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
  return { ...config, entrypoint };
}
