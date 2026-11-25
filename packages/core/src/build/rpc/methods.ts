// Finding the project's RPC methods in its package interface.

import type { NamedType, TypeInterface } from "../package-interface.ts";
import { RpcBuildError, type RpcContext, type RpcMethod } from "./types.ts";
import { Versions } from "./versions.ts";

/**
 * Names the generated `WorkerEntrypoint` can't use for an RPC method: the
 * handlers Cloudflare calls on it, its own `env` and `ctx`, and the members
 * of an RPC stub on the calling side.
 */
const RESERVED = new Set([
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
]);

export async function findMethods(context: RpcContext): Promise<RpcMethod[]> {
  const versions = new Versions(context);
  const methods: RpcMethod[] = [];

  for (const [module, moduleInterface] of Object.entries(context.modules)) {
    for (const [name, fn] of Object.entries(moduleInterface?.functions ?? {})) {
      // A method is a function whose only argument is `worker_rpc.Params`.
      // Other functions that take one, such as helpers with more arguments,
      // aren't methods.
      const [params, ...rest] = fn.parameters;
      if (rest.length > 0 || !isRaysType(params?.type, "Params")) continue;
      const where = `${name} in src/${module}.gleam`;
      const returned = fn.return;
      if (!isPromise(returned)) {
        throw new RpcBuildError(
          `${where} takes a worker_rpc.Params, so it is an RPC method and must return a Promise.`,
        );
      }
      if (RESERVED.has(name) || name.startsWith("__")) {
        throw new RpcBuildError(
          `${where} can't be an RPC method: Cloudflare uses the name ${name} itself. Rename it.`,
        );
      }
      const args = params.type.parameters[0]!;
      const reply = returned.parameters[0]!;
      methods.push({
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

function isRaysType(
  type: TypeInterface | undefined,
  name: string,
): type is NamedType {
  return (
    type?.kind === "named" &&
    type.package === "rays" &&
    type.module === "rays/worker_rpc" &&
    type.name === name
  );
}

function isPromise(type: TypeInterface): type is NamedType {
  return (
    type.kind === "named" &&
    type.package === "gleam_javascript" &&
    type.module === "gleam/javascript/promise" &&
    type.name === "Promise"
  );
}
