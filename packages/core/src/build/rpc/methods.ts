// Finding the project's RPC methods in its package interface.

import { BuildError } from "../error.ts";
import type { NamedType, TypeInterface } from "../package-interface.ts";
import type { RpcContext, RpcMethod } from "./types.ts";
import { Versions } from "./versions.ts";

/**
 * Names the generated `WorkerEntrypoint` can't use for an RPC method: the
 * handlers Cloudflare calls on it, its own `env` and `ctx`, and the members
 * of an RPC stub on the calling side.
 */
const RESERVED = [
  "alarm",
  "connect",
  "constructor",
  "ctx",
  "dup",
  "email",
  "env",
  "fetch",
  "queue",
  "scheduled",
  "tail",
  "tail_stream",
  "test",
  "then",
  "trace",
];

// Each kind of RPC method: the module whose `Params` its argument is, and the
// names it can't use. A Durable Object stub also has `id` and `name`, which
// hide methods with the same name on the calling side.
const KINDS: Record<
  RpcMethod["kind"],
  { module: string; params: string; reserved: ReadonlySet<string> }
> = {
  worker: {
    module: "rays/worker_rpc",
    params: "worker_rpc.Params",
    reserved: new Set(RESERVED),
  },
  durable_object: {
    module: "rays/durable_object",
    params: "durable_object.Params",
    reserved: new Set([...RESERVED, "id", "name"]),
  },
};

export async function findMethods(context: RpcContext): Promise<RpcMethod[]> {
  const versions = new Versions(context);
  const methods: RpcMethod[] = [];

  for (const [module, moduleInterface] of Object.entries(context.modules)) {
    for (const [name, fn] of Object.entries(moduleInterface?.functions ?? {})) {
      // A method is a function whose only argument is `worker_rpc.Params`,
      // or `durable_object.Params` for a Durable Object's. Other functions
      // that take one, such as helpers with more arguments, aren't methods.
      const [params, ...rest] = fn.parameters;
      if (rest.length > 0 || params === undefined) continue;
      const found = methodParams(params.type);
      if (found === undefined) continue;
      const { kind, args } = found;
      const where = `${name} in src/${module}.gleam`;
      const returned = fn.return;
      if (!isPromise(returned)) {
        throw new BuildError(
          `${where} takes a ${KINDS[kind].params}, so it is an RPC method and must return a Promise.`,
        );
      }
      if (KINDS[kind].reserved.has(name) || name.startsWith("__")) {
        throw new BuildError(
          `${where} can't be an RPC method: Cloudflare uses the name ${name} itself. Rename it.`,
        );
      }
      const reply = returned.parameters[0]!;
      methods.push({
        kind,
        module,
        name,
        version: await versions.of(where, args, reply),
      });
    }
  }
  return methods.sort((a, b) =>
    a.name === b.name
      ? a.module.localeCompare(b.module)
      : a.name.localeCompare(b.name),
  );
}

// The kind of RPC method that takes this type as its argument, and the type
// of the arguments it is sent, if it is a `Params`. A Durable Object method's
// memory type isn't part of its version: memory is never sent.
function methodParams(
  type: TypeInterface,
): { kind: RpcMethod["kind"]; args: TypeInterface } | undefined {
  if (type.kind !== "named" || type.package !== "rays") return undefined;
  if (type.name !== "Params") return undefined;
  const kind = (Object.keys(KINDS) as RpcMethod["kind"][]).find(
    (kind) => KINDS[kind].module === type.module,
  );
  return kind === undefined ? undefined : { kind, args: type.parameters[0]! };
}

function isPromise(type: TypeInterface): type is NamedType {
  return (
    type.kind === "named" &&
    type.package === "gleam_javascript" &&
    type.module === "gleam/javascript/promise" &&
    type.name === "Promise"
  );
}
