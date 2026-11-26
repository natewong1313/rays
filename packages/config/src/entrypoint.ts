// The entrypoint specifiers of rays Workers, which `raysWorker()` writes and
// the `rays()` Vite plugin and `raysTestWorkers()` read.
//
// `virtual:rays/worker` is the Worker from the module the plugin defaults to,
// and `virtual:rays/worker/app/admin` the one from `src/app/admin.gleam`.
// Either can end in `?objects=ChatRoom,Counter`: the Durable Object classes
// the Worker declares, which are the only ones its entry module exports.
// Without it, the entry module exports every class in the project, as for a
// Wrangler config file whose `main` is the specifier.

/** The virtual module that exports a rays Worker. */
export const WORKER_MODULE = "virtual:rays/worker";

const OBJECTS = "?objects=";

/** A rays Worker's entrypoint, read from its specifier. */
export interface WorkerEntrypoint {
  /** The Gleam module, or `undefined` for the default one. */
  module: string | undefined;
  /** The Durable Object classes it exports, or `undefined` for all. */
  objects: string[] | undefined;
}

/** The specifier for a rays Worker's entrypoint. */
export function formatEntrypoint({
  module,
  objects,
}: WorkerEntrypoint): string {
  return (
    WORKER_MODULE +
    (module === undefined ? "" : `/${module}`) +
    (objects === undefined ? "" : OBJECTS + objects.join(","))
  );
}

/**
 * The rays Worker entrypoint a specifier names, or `undefined` if it isn't
 * one.
 */
export function parseEntrypoint(
  specifier: string,
): WorkerEntrypoint | undefined {
  if (!specifier.startsWith(WORKER_MODULE)) return undefined;
  let rest = specifier.slice(WORKER_MODULE.length);
  let objects: string[] | undefined;
  const query = rest.indexOf(OBJECTS);
  if (query !== -1) {
    const list = rest.slice(query + OBJECTS.length);
    objects = list === "" ? [] : list.split(",");
    rest = rest.slice(0, query);
  }
  if (rest === "") return { module: undefined, objects };
  if (!rest.startsWith("/") || rest.includes("?")) return undefined;
  return { module: rest.slice(1), objects };
}
