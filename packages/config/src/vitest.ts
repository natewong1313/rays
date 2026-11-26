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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigContext } from "cf/config";
import { build as bundle } from "vite";
import { compile, entrySource, selectDurableObjects } from "@rays/core/build";
import { parseEntrypoint, type WorkerEntrypoint } from "./entrypoint.ts";

/** A Worker configuration, as `cloudflare.config.ts` holds it. */
interface WorkerLike {
  name?: unknown;
  entrypoint?: unknown;
  compatibilityDate?: unknown;
  compatibilityFlags?: unknown;
  env?: unknown;
  exports?: unknown;
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
 * Each Worker is built as for a deployment: its entry module, as the
 * `rays()` plugin makes it, is written to `.rays/test/<name>.entry.js`, with
 * the Durable Object classes its configuration declares, and Vite bundles it
 * into `.rays/test/<name>.js`. Its name,
 * compatibility date and flags come from its configuration, and so do its
 * `bindings.text()`, `bindings.json()`, `bindings.worker()` and
 * `bindings.durableObject()` bindings. A Worker bound only through a Durable
 * Object binding, because it defines the class, is run too. A class uses
 * SQLite storage unless the configuration of the Worker that defines it
 * declares it with `legacy-kv`; for a Worker given only by name, which this
 * can't read, SQLite is assumed.
 *
 * @throws {TypeError} If a Worker has a binding this can't set up, and no
 *   `overrides` entry for that Worker.
 * @throws {BuildError} If the project fails to compile, or a Worker declares
 *   a Durable Object class that isn't in the project.
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

  const rays = workers.flatMap((worker) => {
    const entrypoint = raysEntrypoint(worker);
    return entrypoint === undefined ? [] : [{ worker, entrypoint }];
  });
  if (rays.length === 0) return [];

  const project = await compile({ root });
  const outDir = path.join(root, ".rays", "test");
  await mkdir(outDir, { recursive: true });
  const result: TestWorkerOptions[] = [];
  for (const { worker, entrypoint } of rays) {
    const name = nameOf(worker);
    const scriptPath = path.join(outDir, `${name}.js`);
    const entry = path.join(outDir, `${name}.entry.js`);
    // `raysWorker()` without `module` means the module named after the
    // package, as for the rays() plugin's default.
    const module = entrypoint.module || project.packageName;
    await writeFile(
      entry,
      entrySource(module, project.workerModule(module), {
        generator: "raysTestWorkers()",
        typescript: false,
        rpc: project.rpc,
        durableObjects: selectDurableObjects(
          project.durableObjects,
          entrypoint.objects,
        ),
        specifier: (file) => relativeSpecifier(outDir, file),
      }),
    );
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
          entry,
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
    for (const binding of Object.values(envOf(worker)).map(parseBinding)) {
      // Only a Worker given by its configuration can be run.
      if (binding.kind !== "service" && binding.kind !== "durable-object")
        continue;
      if (binding.worker === undefined || typeof binding.worker === "string")
        continue;
      const bound = await resolve(binding.worker, ctx);
      const name = nameOf(bound);
      if (name === main.name || found.has(name)) continue;
      found.set(name, bound);
      await visit(bound);
    }
  };
  await visit(main);
  return [...found.values()];
}

// The rays Worker entrypoint of a Worker's configuration, or `undefined`
// if `raysWorker()` didn't make it.
function raysEntrypoint(worker: WorkerLike): WorkerEntrypoint | undefined {
  return typeof worker.entrypoint === "string"
    ? parseEntrypoint(worker.entrypoint)
    : undefined;
}

// The import specifier of `file` from a module in `dir`.
function relativeSpecifier(dir: string, file: string): string {
  const relative = path.relative(dir, file).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
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

// A binding in a Worker's `env`, in the forms this can set up. A service or
// Durable Object binding's `worker` is the Worker that serves it, by its
// configuration or its name; a Durable Object binding without one is to a
// class of the binding Worker itself.
type Binding =
  | { kind: "value"; value: unknown }
  | { kind: "service"; worker: CloudflareConfigInput | string }
  | {
      kind: "durable-object";
      worker: CloudflareConfigInput | string | undefined;
      className: string;
    }
  | { kind: "unsupported"; type: unknown };

function parseBinding(binding: unknown): Binding {
  const { type, value, worker, exportName } = (
    typeof binding === "object" && binding !== null ? binding : {}
  ) as {
    type?: unknown;
    value?: unknown;
    worker?: unknown;
    exportName?: unknown;
  };
  const target = worker as CloudflareConfigInput | string | undefined;
  switch (type) {
    case "text":
    case "json":
      return { kind: "value", value };
    case "worker":
      if (target !== undefined) return { kind: "service", worker: target };
      break;
    case "durable-object":
      if (typeof exportName === "string") {
        return {
          kind: "durable-object",
          worker: target,
          className: exportName,
        };
      }
      break;
  }
  return { kind: "unsupported", type };
}

// The name of the Worker a binding's `worker` gives.
function workerName(target: CloudflareConfigInput | string): string {
  return typeof target === "string" ? target : nameOf(target as WorkerLike);
}

// Miniflare's options for a Durable Object binding of `worker`. The class is
// in the Worker the binding names, or `worker` itself, and uses SQLite
// storage unless that Worker's configuration declares it with `legacy-kv`.
// A Worker given by name isn't known here, so it is assumed to use SQLite.
function durableObjectOptions(
  worker: WorkerLike,
  binding: Extract<Binding, { kind: "durable-object" }>,
): Record<string, unknown> {
  const { className } = binding;
  const scriptName = workerName(binding.worker ?? worker);
  const declaring =
    scriptName === nameOf(worker)
      ? worker
      : (binding.worker as WorkerLike | string);
  return {
    className,
    ...(declaring === worker ? {} : { scriptName }),
    useSQLite:
      typeof declaring === "string" ||
      storageOf(declaring, className) !== "legacy-kv",
  };
}

// The storage a Worker's configuration declares for a class, if it does.
function storageOf(worker: WorkerLike, className: string): unknown {
  const exports = worker.exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const entry = (exports as Record<string, unknown>)[className];
  return typeof entry === "object" && entry !== null
    ? (entry as { storage?: unknown }).storage
    : undefined;
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
  const durableObjects: Record<string, unknown> = {};
  const unsupported: string[] = [];
  for (const [key, raw] of Object.entries(envOf(worker))) {
    const binding = parseBinding(raw);
    switch (binding.kind) {
      case "value":
        bindings[key] = binding.value;
        break;
      case "service":
        serviceBindings[key] = workerName(binding.worker);
        break;
      case "durable-object":
        durableObjects[key] = durableObjectOptions(worker, binding);
        break;
      case "unsupported":
        unsupported.push(`${key} (${String(binding.type)})`);
        break;
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
  if (Object.keys(durableObjects).length > 0) {
    options.durableObjects = durableObjects;
  }
  return options;
}
