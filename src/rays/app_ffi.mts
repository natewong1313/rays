// FFI shim for `rays/app`: the Worker's env, and the class name of a
// Durable Object class, from the registry the build's footers fill in, or
// worked out from the function's name as the build does when there is no
// build.

import { Result$Error, Result$Ok } from "../gleam.mjs";
import type { Result } from "../gleam.mjs";
import { currentEnv as readEnv, type Env } from "./worker_ffi.mts";
import { registeredClassName, type ClassFunction } from "./worker_rpc_ffi.mts";

export function className(classFunction: ClassFunction): string {
  const registered = registeredClassName(classFunction);
  if (registered !== undefined) return registered;
  // Gleam adds a `$` to a function named after a JavaScript reserved word.
  return classFunction.name
    .replace(/\$$/, "")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function currentEnv(): Result<Env, undefined> {
  const env = readEnv();
  return env === undefined ? Result$Error(undefined) : Result$Ok(env);
}
