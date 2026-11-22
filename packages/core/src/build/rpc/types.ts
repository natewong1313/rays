// What the parts of the RPC build step share.

import type { ModuleInterface } from "../package-interface.ts";

/** A build failure with a message meant for the developer. */
export class RpcBuildError extends Error {
  override name = "RpcBuildError";
}

/** An RPC method: a public function taking `workers_rpc.Params`. */
export interface RpcMethod {
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
