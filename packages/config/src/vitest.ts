/**
 * Run a project's other rays Workers in tests with the Workers Vitest
 * integration, `@cloudflare/vitest-plugin`.
 *
 * `cloudflareTest()` builds only the Worker under test. Any other Worker it
 * calls through a service binding runs as an auxiliary Worker, which must
 * already be compiled to JavaScript and described with Miniflare's
 * `WorkerOptions`. {@link raysTestWorkers} does both for the rays Workers
 * the Worker under test binds, so calls between them, including Workers RPC
 * with `rays/worker_rpc`, run for real in `workerd`:
 *
 * ```ts
 * // vitest.config.ts
 * import { cloudflareTest } from "@cloudflare/vitest-plugin";
 * import { rays } from "@rays/config/vite";
 * import { raysTestWorkers } from "@rays/config/vitest";
 * import { defineConfig } from "vitest/config";
 * import cloudflareConfig from "./cloudflare.config.ts";
 *
 * export default defineConfig({
 *   plugins: [
 *     rays(),
 *     cloudflareTest(async () => ({
 *       config: true,
 *       miniflare: { workers: await raysTestWorkers(cloudflareConfig) },
 *     })),
 *   ],
 * });
 * ```
 *
 * The Workers are built when Vitest starts. In watch mode, changes to them
 * take effect when Vitest is restarted.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ConfigContext } from "cf/config";
import { build as bundle } from "vite";
import { build, readPackageName } from "@rays/core/build";

/** A Worker configuration, as `cloudflare.config.ts` holds it. */
interface WorkerLike {
  name?: unknown;
  entrypoint?: unknown;
  compatibilityDate?: unknown;
  compatibilityFlags?: unknown;
  env?: unknown;
}

/** What `cf/config`'s `defineConfig()` accepts, in any of its forms. */
export type CloudflareConfigInput =
  object | Promise<object> | ((ctx: ConfigContext) => object | Promise<object>);

/** Miniflare's `WorkerOptions` for one auxiliary Worker. */
export type TestWorkerOptions = Record<string, unknown> & {
  name: string;
  modules: true;
  scriptPath: string;
};

export interface RaysTestWorkersOptions {
  /** The directory holding `gleam.toml`. Defaults to the current directory. */
  root?: string;
  /**
   * The mode `cloudflare.config.ts` is evaluated in, if it exports a
   * function. Defaults to `"test"`, as `cloudflareTest()` uses.
   */
  mode?: string;
  /**
   * Extra Miniflare `WorkerOptions` for each Worker, by name, merged over the
   * ones made from its configuration. Use it for bindings this can't set up
   * from `cloudflare.config.ts`, such as KV namespaces.
   */
  overrides?: Record<string, Record<string, unknown>>;
}

/**
 * Build the rays Workers that the Worker under test binds, and describe
 * them as auxiliary Workers for `cloudflareTest()`'s `miniflare.workers`.
 *
 * Pass the default export of `cloudflare.config.ts`: the Workers bound by its
 * `worker`, and by those Workers in turn, are found from their
 * `bindings.worker()` bindings. Only Workers made with `raysWorker()` are
 * built. Alternatively, pass the rays Worker configurations to run.
 *
 * Each Worker is built as for a deployment: `rays build` writes its entry
 * module, and Vite bundles it into `.rays/test/<name>.js`. Its name,
 * compatibility date and flags come from its configuration, and so do its
 * `bindings.text()`, `bindings.json()` and `bindings.worker()` bindings.
 *
 * @throws {TypeError} If a Worker has a binding this can't set up, and no
 *   `overrides` entry for that Worker.
 */
export async function raysTestWorkers(
  from: CloudflareConfigInput | readonly CloudflareConfigInput[],
  options: RaysTestWorkersOptions = {},
): Promise<TestWorkerOptions[]> {
  const root = path.resolve(options.root ?? ".");
  const ctx: ConfigContext = { isPreview: false, mode: options.mode ?? "test" };
  const workers = Array.isArray(from)
    ? await Promise.all(from.map((worker) => resolve(worker, ctx)))
    : await boundWorkers(await resolve(from, ctx), ctx);

  const rays = workers.filter((worker) => raysModule(worker) !== undefined);
  if (rays.length === 0) return [];

  // `raysWorker()` without `module` means the module named after the
  // package, as for the rays() plugin's default.
  const packageName = await readPackageName(root);
  const moduleOf = (worker: WorkerLike) => raysModule(worker) || packageName;
  const modules = [...new Set(rays.map(moduleOf))];
  const entries = await build({ root, modules });
  const entryFor = (module: string) =>
    entries.find((entry) => entry.module === module)!.path;

  const outDir = path.join(root, ".rays", "test");
  await mkdir(outDir, { recursive: true });
  const result: TestWorkerOptions[] = [];
  for (const worker of rays) {
    const name = nameOf(worker);
    const scriptPath = path.join(outDir, `${name}.js`);
    await bundle({
      configFile: false,
      root,
      logLevel: "warn",
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        target: "esnext",
        lib: {
          entry: entryFor(moduleOf(worker)),
          formats: ["es"],
          fileName: () => `${name}.js`,
        },
        // Read as rolldownOptions by Vite 8, which bundles with Rolldown.
        rollupOptions: { external: [/^cloudflare:/, /^node:/] },
      },
    });
    result.push({
      ...workerOptions(worker, options.overrides?.[name] !== undefined),
      ...options.overrides?.[name],
      name,
      modules: true,
      scriptPath,
    });
  }
  return result;
}

async function resolve(
  input: CloudflareConfigInput,
  ctx: ConfigContext,
): Promise<WorkerLike> {
  const value = typeof input === "function" ? input(ctx) : input;
  return (await value) as WorkerLike;
}

// The Workers bound, directly or through each other, by the config's main
// Worker, which `cloudflareTest()` runs itself.
async function boundWorkers(
  config: object,
  ctx: ConfigContext,
): Promise<WorkerLike[]> {
  const main = await resolve(
    (config as { worker?: CloudflareConfigInput }).worker ?? {},
    ctx,
  );
  const found = new Map<string, WorkerLike>();
  const visit = async (worker: WorkerLike) => {
    for (const binding of Object.values(envOf(worker))) {
      if (!isWorkerBinding(binding) || typeof binding.worker === "string")
        continue;
      const bound = await resolve(binding.worker as CloudflareConfigInput, ctx);
      const name = nameOf(bound);
      if (name === main.name || found.has(name)) continue;
      found.set(name, bound);
      await visit(bound);
    }
  };
  await visit(main);
  return [...found.values()];
}

// The Gleam module a rays Worker comes from, `""` for the default one, or
// `undefined` if `raysWorker()` didn't make it.
function raysModule(worker: WorkerLike): string | undefined {
  const entrypoint = worker.entrypoint;
  if (entrypoint === "virtual:rays/worker") return "";
  if (
    typeof entrypoint === "string" &&
    entrypoint.startsWith("virtual:rays/worker/")
  ) {
    return entrypoint.slice("virtual:rays/worker/".length);
  }
  return undefined;
}

function nameOf(worker: WorkerLike): string {
  if (typeof worker.name !== "string" || worker.name === "") {
    throw new TypeError(
      "raysTestWorkers(): every Worker it runs needs a name in its configuration.",
    );
  }
  return worker.name;
}

function envOf(worker: WorkerLike): Record<string, unknown> {
  return typeof worker.env === "object" && worker.env !== null
    ? (worker.env as Record<string, unknown>)
    : {};
}

function isWorkerBinding(
  binding: unknown,
): binding is { type: "worker"; worker: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    (binding as { type?: unknown }).type === "worker"
  );
}

// Miniflare options for the parts of a Worker's configuration this knows.
function workerOptions(
  worker: WorkerLike,
  overridden: boolean,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (typeof worker.compatibilityDate === "string") {
    options.compatibilityDate = worker.compatibilityDate;
  }
  if (Array.isArray(worker.compatibilityFlags)) {
    options.compatibilityFlags = worker.compatibilityFlags;
  }

  const bindings: Record<string, unknown> = {};
  const serviceBindings: Record<string, string> = {};
  const unsupported: string[] = [];
  for (const [key, binding] of Object.entries(envOf(worker))) {
    const { type, value } = binding as { type?: unknown; value?: unknown };
    if (type === "text" || type === "json") {
      bindings[key] = value;
    } else if (isWorkerBinding(binding)) {
      const target = binding.worker;
      serviceBindings[key] =
        typeof target === "string" ? target : nameOf(target as WorkerLike);
    } else {
      unsupported.push(`${key} (${String(type)})`);
    }
  }
  if (unsupported.length > 0 && !overridden) {
    throw new TypeError(
      `raysTestWorkers(): the Worker ${nameOf(worker)} has bindings it can't set up: ${unsupported.join(", ")}. Give them as Miniflare options with overrides: { ${JSON.stringify(nameOf(worker))}: { ... } }.`,
    );
  }
  if (Object.keys(bindings).length > 0) options.bindings = bindings;
  if (Object.keys(serviceBindings).length > 0) {
    options.serviceBindings = serviceBindings;
  }
  return options;
}
