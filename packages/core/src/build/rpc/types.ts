// What the parts of the RPC build step share.

import type { ModuleInterface } from "../package-interface.ts";

/**
 * An RPC method: a public function taking `worker_rpc.Params`, or
 * `durable_object.Params` for a method of a Durable Object class.
 */
export interface RpcMethod {
  /** Whether a Worker or a Durable Object class serves it. */
  kind: "worker" | "durable_object";
  /** The Gleam module it is defined in. */
  module: string;
  /** Its name, which is also the name of the Workers RPC method. */
  name: string;
  /** A hash of its argument and reply types, and of the types they hold. */
  version: string;
}

/** The project being built, as every part of the build step sees it. */
export interface RpcContext {
  root: string;
  packageName: string;
  modules: Record<string, ModuleInterface | undefined>;
  javascript: string;
}
