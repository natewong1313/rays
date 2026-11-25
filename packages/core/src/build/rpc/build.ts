/**
 * The build step behind `rays/worker_rpc`.
 *
 * Workers RPC can't copy Gleam values, which are class instances, so
 * `rays/worker_rpc` encodes them into plain data and decodes them back into
 * the same classes. For that, every class has to be found again by name. The
 * Gleam compiler has no hooks, so after it compiles the project this appends
 * a footer to every compiled module, inside the module where even an opaque
 * type's private class is in scope, that registers its custom types and RPC
 * methods with the registry in `rays/worker_rpc`'s FFI.
 *
 * It also finds the RPC methods, so the entry module can give its
 * `WorkerEntrypoint` one method for each, and gives each a version that
 * changes whenever the types it sends do. And it finds the Durable Object
 * classes of `rays/durable_object`, which the entry module exports with one
 * method for each Durable Object method.
 *
 * @module
 */

import path from "node:path";
import {
  findDurableObjectClasses,
  type DurableObjectClass,
} from "../durable-object.ts";
import type { ModuleInterface } from "../package-interface.ts";
import { writeFooters } from "./footers.ts";
import { findMethods } from "./methods.ts";
import type { RpcContext, RpcMethod } from "./types.ts";

export type { RpcMethod } from "./types.ts";

/** A project's Workers RPC methods, which a Worker's entry module serves. */
export interface WorkerRpc {
  /** The methods, sorted by name. */
  methods: RpcMethod[];
  /** The absolute path of `rays/worker_rpc`'s FFI module, in the build. */
  ffi: string;
}

/** A Durable Object class, with the compiled module that defines it. */
export interface BuiltDurableObjectClass extends DurableObjectClass {
  /**
   * The absolute path of the compiled module, whose footer registers the
   * class: the entry module imports it, then finds the class by name.
   */
  compiled: string;
}

/** A project's Durable Object classes, which every entry module exports. */
export interface DurableObjects {
  /** The classes, sorted by class name. */
  classes: BuiltDurableObjectClass[];
  /** The Durable Object methods, sorted by name, which every class has. */
  methods: RpcMethod[];
  /** The absolute path of `rays/durable_object`'s FFI module, in the build. */
  ffi: string;
}

/** What the build step found and wrote. */
export interface RpcBuild {
  /** The Workers RPC methods, or `undefined` if the project has none. */
  rpc: WorkerRpc | undefined;
  /** The Durable Object classes, or `undefined` if the project has none. */
  durableObjects: DurableObjects | undefined;
}

/**
 * Register the project's custom types, RPC methods and Durable Object
 * classes, by rewriting the footer of every compiled module in the build
 * directory.
 *
 * A project without RPC methods or classes gets no footers, and any left by
 * an earlier build are removed. Files are only written when their footer
 * changes.
 *
 * @returns What was found.
 * @throws {BuildError} If a method or class can't be used, for example
 *   because it is generic or sends a function.
 */
export async function buildRpc(options: {
  root: string;
  packageName: string;
  modules: Record<string, ModuleInterface | undefined>;
}): Promise<RpcBuild> {
  const context: RpcContext = {
    ...options,
    javascript: path.join(options.root, "build", "dev", "javascript"),
  };
  const ffi = (module: string) =>
    path.join(context.javascript, "rays", "rays", `${module}_ffi.mts`);
  const methods = await findMethods(context);
  const classes = findDurableObjectClasses(options.modules);
  await writeFooters(context, { methods, classes }, ffi("worker_rpc"));

  const ofKind = (kind: RpcMethod["kind"]) =>
    methods.filter((method) => method.kind === kind);
  const workerMethods = ofKind("worker");
  return {
    rpc:
      workerMethods.length === 0
        ? undefined
        : { methods: workerMethods, ffi: ffi("worker_rpc") },
    durableObjects:
      classes.length === 0
        ? undefined
        : {
            classes: classes.map((object) => ({
              ...object,
              compiled: path.join(
                context.javascript,
                context.packageName,
                `${object.module}.mjs`,
              ),
            })),
            methods: ofKind("durable_object"),
            ffi: ffi("durable_object"),
          },
  };
}
