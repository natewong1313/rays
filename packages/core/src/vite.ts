/**
 * A Vite plugin that builds rays Workers from Gleam.
 *
 * Add it before Cloudflare's plugin, and use `virtual:rays/worker` as the
 * Worker's main module:
 *
 * ```ts
 * // vite.config.ts
 * import { cloudflare } from "@cloudflare/vite-plugin";
 * import { rays } from "@rays/core/vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({ plugins: [rays(), cloudflare()] });
 * ```
 *
 * ```jsonc
 * // wrangler.jsonc
 * { "main": "virtual:rays/worker" }
 * ```
 *
 * `virtual:rays/worker` exports the Worker returned by `pub fn main()` in the
 * module named after the Gleam package. `virtual:rays/worker/<module>`, such
 * as `virtual:rays/worker/app/admin`, exports the one in another module, for
 * projects with several Workers.
 *
 * The plugin compiles the project when Vite starts and whenever a file in
 * `src/`, `gleam.toml` or `manifest.toml` changes. In development a failed
 * compile is shown in the terminal and the browser's error overlay, and the
 * last good build keeps running. `vite build` fails instead.
 *
 * It works with Cloudflare's Vite plugin v1 (`main` in a Wrangler config
 * file) and v2 (`worker.entrypoint` in `cloudflare.config.ts`). For tests,
 * add it before `cloudflareTest()` in `vitest.config.ts`. Cloudflare's Vitest
 * plugin then warns that it can't analyze the exports of the virtual module;
 * that only matters for Durable Objects and named entrypoints, which rays
 * Workers don't export.
 *
 * With `cloudflare.config.ts`, use `raysWorker()` from `@rays/core/cf`
 * to configure the Worker; it sets `entrypoint`.
 *
 * For types, add `"types": ["@rays/core/virtual"]` to `tsconfig.json`.
 * `wrangler types` can't see what a virtual module exports, so when a
 * Wrangler config file's `main` is `virtual:rays/worker`, use
 * `"types": ["@rays/core/main"]` instead: it also types `exports` from
 * `cloudflare:workers`. With `raysWorker()`, the types `cf` generates already
 * do that.
 *
 * @module
 */

import path from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { BuildError, compile, entrySource, type Project } from "./build.ts";

/** The virtual module that exports a rays Worker. */
export const WORKER_MODULE = "virtual:rays/worker";

export interface RaysOptions {
  /**
   * The directory holding `gleam.toml`, relative to Vite's root. Defaults to
   * Vite's root.
   */
  root?: string;
  /**
   * The module `virtual:rays/worker` builds the Worker from. Defaults to the
   * module named after the Gleam package.
   */
  module?: string;
  /** The `gleam` executable. Defaults to `$RAYS_GLEAM_BIN`, then `gleam`. */
  gleam?: string;
}

const RESOLVED_PREFIX = `\0${WORKER_MODULE}`;

/** Build rays Workers from the Gleam project. */
export function rays(options: RaysOptions = {}): Plugin {
  let config: ResolvedConfig;
  let root: string;
  let server: ViteDevServer | undefined;

  // The last successful build, and the error from the latest one if it
  // failed. In development the last good build is used until a new one
  // succeeds.
  let good: Project | undefined;
  let failure: Error | undefined;

  // Builds run one at a time. Changes during a build queue one more, which
  // picks up all of them.
  let tail: Promise<void> | undefined;
  let queued: Promise<void> | undefined;

  function schedule(): Promise<void> {
    queued ??= (tail ?? Promise.resolve()).then(async () => {
      queued = undefined;
      await buildOnce();
    });
    tail = queued;
    return queued;
  }

  async function buildOnce(): Promise<void> {
    try {
      good = await compile({
        root,
        gleam: options.gleam,
        // In development, keep Gleam's errors for the error overlay. A build
        // prints them once, and fails.
        output: config.command === "serve" ? "tee" : "inherit",
      });
      failure = undefined;
    } catch (error) {
      failure = error as Error;
      report(failure);
      return;
    }
    recheckWorkers(good);
  }

  // Whether each loaded Worker module failed its check in the last build.
  const broken = new Map<string, boolean>();

  // Vite reloads changed Gleam code itself, but it doesn't reload a virtual
  // module, which is where a Worker module is checked. Check the loaded ones
  // again, and reload a Worker whose check started or stopped failing.
  function recheckWorkers(project: Project): void {
    if (server === undefined) return;
    for (const environment of Object.values(server.environments)) {
      let reload = false;
      for (const [id, node] of environment.moduleGraph.idToModuleMap) {
        if (!id.startsWith(RESOLVED_PREFIX)) continue;
        const module = moduleFor(id, project);
        let failed = false;
        try {
          project.workerModule(module);
        } catch (error) {
          failed = true;
          report(error as Error);
        }
        if (broken.get(id) !== failed) {
          broken.set(id, failed);
          environment.moduleGraph.invalidateModule(node);
          reload = true;
        }
      }
      if (reload) environment.hot.send({ type: "full-reload" });
    }
  }

  function moduleFor(id: string, project: Project): string {
    return id === RESOLVED_PREFIX
      ? (options.module ?? project.packageName)
      : id.slice(RESOLVED_PREFIX.length + 1);
  }

  function report(error: Error): void {
    config.logger.error(`[rays] ${error.message}`, { timestamp: true });
    server?.ws.send({
      type: "error",
      err: {
        message: describe(error),
        stack: "",
        plugin: "rays",
      },
    });
  }

  function isProjectFile(file: string): boolean {
    const relative = path.relative(root, file);
    return (
      relative === "gleam.toml" ||
      relative === "manifest.toml" ||
      (relative.startsWith(`src${path.sep}`) && !relative.includes(".."))
    );
  }

  return {
    name: "rays",
    // Before Cloudflare's plugin, which loads the Worker's main module.
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
      root = path.resolve(resolved.root, options.root ?? ".");
    },

    configureServer(devServer) {
      server = devServer;
      devServer.watcher.add([
        path.join(root, "src"),
        path.join(root, "gleam.toml"),
        path.join(root, "manifest.toml"),
      ]);
      devServer.watcher.on("all", (event, file) => {
        if (event === "addDir" || event === "unlinkDir") return;
        if (isProjectFile(path.resolve(file))) void schedule();
      });
    },

    // Called once per environment; only the first starts a build.
    async buildStart() {
      await (tail ?? schedule());
      if (failure !== undefined && config.command === "build") {
        this.error(describe(failure));
      }
    },

    resolveId(id) {
      const specifier = workerSpecifier(id);
      if (specifier !== undefined) return `\0${specifier}`;
    },

    async load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return;
      await (tail ?? schedule());
      if (good === undefined) throw failure;

      const module = moduleFor(id, good);
      let compiled: string;
      try {
        compiled = good.workerModule(module);
        broken.set(id, false);
      } catch (error) {
        broken.set(id, true);
        throw error;
      }
      return entrySource(module, compiled.split(path.sep).join("/"), {
        generator: "the rays Vite plugin",
        typescript: false,
      });
    },
  };
}

// The `virtual:rays/worker` specifier in `id`, if it is one. Cloudflare's
// Vitest plugin treats the Worker's main module as a path, so it asks for
// `/path/to/project/virtual:rays/worker` instead.
function workerSpecifier(id: string): string | undefined {
  const at = id.indexOf(WORKER_MODULE);
  if (at === -1 || (at > 0 && id[at - 1] !== "/")) return undefined;
  const specifier = id.slice(at);
  const rest = specifier.slice(WORKER_MODULE.length);
  return rest === "" || rest.startsWith("/") ? specifier : undefined;
}

// The message for the error overlay: Gleam's own errors when it has them.
function describe(error: Error): string {
  if (error instanceof BuildError && error.output !== "") {
    return `${error.message}\n\n${error.output}`;
  }
  return error.message;
}
