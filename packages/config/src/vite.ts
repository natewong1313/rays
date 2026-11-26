/**
 * A Vite plugin that builds rays Workers from Gleam.
 *
 * Add it before Cloudflare's plugin, and use `virtual:rays/worker` as the
 * Worker's main module:
 *
 * ```ts
 * // vite.config.ts
 * import { cloudflare } from "@cloudflare/vite-plugin";
 * import { rays } from "@rays/config/vite";
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
 * The module also exports Durable Object classes, from
 * `rays/durable_object`: the ones `raysWorker()` declares, or, for a
 * Wrangler config file's `main`, every class in the project. A class the
 * configuration declares that isn't in the project fails the build.
 *
 * It works with Cloudflare's Vite plugin v1 (`main` in a Wrangler config
 * file) and v2 (`worker.entrypoint` in `cloudflare.config.ts`). For tests,
 * add it before `cloudflareTest()` in `vitest.config.ts`. Cloudflare's Vitest
 * plugin then warns that it can't analyze the exports of the virtual module.
 * It finds Durable Object classes in the configuration's `exports` instead,
 * where they are declared, so the warning only matters for named
 * entrypoints, which rays Workers don't export.
 *
 * With `cloudflare.config.ts`, use `raysWorker()` from `@rays/config/cf`
 * to configure the Worker; it sets `entrypoint`.
 *
 * For types, add `"types": ["@rays/config/virtual"]` to `tsconfig.json`.
 * `wrangler types` can't see what a virtual module exports, so when a
 * Wrangler config file's `main` is `virtual:rays/worker`, use
 * `"types": ["@rays/config/main"]` instead: it also types `exports` from
 * `cloudflare:workers`. With `raysWorker()`, the types `cf` generates already
 * do that.
 *
 * @module
 */

import path from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import {
  BuildError,
  compile,
  entrySource,
  selectDurableObjects,
  type Project,
} from "@rays/core/build";
import { parseEntrypoint, WORKER_MODULE } from "./entrypoint.ts";

export { WORKER_MODULE };

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

  // The source each loaded Worker module had in the last build, or
  // `undefined` if its check failed.
  const loaded = new Map<string, string | undefined>();

  // Vite reloads changed Gleam code itself, but it doesn't reload a virtual
  // module, which is where a Worker module is checked and its RPC methods
  // and Durable Object classes are generated. Generate the loaded ones
  // again, and reload a Worker whose module changed, or whose check started
  // or stopped failing.

  function recheckWorkers(project: Project): void {
    if (server === undefined) return;
    for (const environment of Object.values(server.environments)) {
      let reload = false;
      for (const [id, node] of environment.moduleGraph.idToModuleMap) {
        if (!id.startsWith(RESOLVED_PREFIX)) continue;
        let source: string | undefined;
        try {
          source = workerSource(id, project);
        } catch (error) {
          report(error as Error);
        }
        if (!loaded.has(id) || loaded.get(id) !== source) {
          loaded.set(id, source);
          environment.moduleGraph.invalidateModule(node);
          reload = true;
        }
      }
      if (reload) environment.hot.send({ type: "full-reload" });
    }
  }

  // The source of the Worker module `id`.
  function workerSource(id: string, project: Project): string {
    const entrypoint = parseEntrypoint(id.slice(1))!;
    const module = entrypoint.module || (options.module ?? project.packageName);
    return entrySource(module, project.workerModule(module), {
      generator: "the rays Vite plugin",
      typescript: false,
      rpc: project.rpc,
      durableObjects: selectDurableObjects(
        project.durableObjects,
        entrypoint.objects,
      ),
      specifier: toSpecifier,
    });
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

    // The dev server waits for this as it closes, so no build is still
    // writing to the project once `server.close()` resolves. A change can
    // queue one more build while it waits.
    async closeBundle() {
      let waited: Promise<void> | undefined;
      while (tail !== waited) {
        waited = tail;
        await waited;
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

      try {
        const source = workerSource(id, good);
        loaded.set(id, source);
        return source;
      } catch (error) {
        loaded.set(id, undefined);
        throw error;
      }
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
  return parseEntrypoint(specifier) === undefined ? undefined : specifier;
}

function toSpecifier(file: string): string {
  return file.split(path.sep).join("/");
}

// The message for the error overlay: Gleam's own errors when it has them.
function describe(error: Error): string {
  if (error instanceof BuildError && error.output !== "") {
    return `${error.message}\n\n${error.output}`;
  }
  return error.message;
}
