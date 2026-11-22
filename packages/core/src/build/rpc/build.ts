/**
 * The build step behind `rays/workers_rpc`.
 *
 * Workers RPC can't copy Gleam values, which are class instances, so
 * `rays/workers_rpc` encodes them into plain data and decodes them back into
 * the same classes. For that, every class has to be found again by name. The
 * Gleam compiler has no hooks, so after it compiles the project this appends
 * a footer to every compiled module, inside the module where even an opaque
 * type's private class is in scope, that registers its custom types and RPC
 * methods with the registry in `rays/workers_rpc`'s FFI.
 *
 * It also finds the RPC methods, so the entry module can give its
 * `WorkerEntrypoint` one method for each, and gives each a version that
 * changes whenever the types it sends do.
 *
 * @module
 */

import path from "node:path";
import type { ModuleInterface } from "../package-interface.ts";
import { writeFooters } from "./footers.ts";
import { findMethods } from "./methods.ts";
import type { RpcContext, RpcMethod } from "./types.ts";

export { RpcBuildError, type RpcMethod } from "./types.ts";

/** What the build step found and wrote. */
export interface RpcBuild {
  /** The project's RPC methods, sorted by name. */
  methods: RpcMethod[];
  /** The absolute path of `rays/workers_rpc`'s FFI module, in the build. */
  ffi: string;
}

/**
 * Register the project's custom types and RPC methods, by rewriting the
 * footer of every compiled module in the build directory.
 *
 * A project without RPC methods gets no footers, and any left by an earlier
 * build are removed. Files are only written when their footer changes.
 *
 * @returns What was found, or `undefined` if the project has no RPC methods.
 * @throws {RpcBuildError} If a method can't be used, for example because it
 *   is generic or sends a function.
 */
export async function buildRpc(options: {
  root: string;
  packageName: string;
  modules: Record<string, ModuleInterface | undefined>;
}): Promise<RpcBuild | undefined> {
  const context: RpcContext = {
    ...options,
    javascript: path.join(options.root, "build", "dev", "javascript"),
  };
  const methods = await findMethods(context);
  const ffi = path.join(
    context.javascript,
    "rays",
    "rays",
    "workers_rpc_ffi.mts",
  );
  await writeFooters(context, methods, ffi);
  return methods.length === 0 ? undefined : { methods, ffi };
}
