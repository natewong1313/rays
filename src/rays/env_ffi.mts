// FFI shim over a Worker's bindings (`env`) and `ExecutionContext`.

import { Result$Error, Result$Ok } from "../gleam.mjs";
import type { Result } from "../gleam.mjs";

export type Env = Record<string, unknown>;

export function envVar(env: Env, name: string): Result<string, undefined> {
  const value = env?.[name];
  return typeof value === "string" ? Result$Ok(value) : Result$Error(undefined);
}

export function envBinding(env: Env, name: string): Result<unknown, undefined> {
  const value = env?.[name];
  return value === undefined || value === null
    ? Result$Error(undefined)
    : Result$Ok(value);
}

export function waitUntil(
  ctx: ExecutionContext,
  promise: Promise<unknown>,
): undefined {
  ctx.waitUntil(promise);
}

export function passThroughOnException(ctx: ExecutionContext): undefined {
  ctx.passThroughOnException();
}
