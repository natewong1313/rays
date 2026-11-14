// FFI shim between the Cloudflare Workers runtime and `rays/workers`.

import { Result$Error, Result$Ok } from "../gleam.mjs";
import type { Result } from "../gleam.mjs";
import type { Env } from "./env_ffi.mts";

// `ExportedHandler` and others are from `@cloudflare/workers-types`.
type FetchFn = ExportedHandlerFetchHandler<Env>;

export function makeWorker(fetch: FetchFn): ExportedHandler<Env> {
  return { fetch: (request, env, ctx) => fetch(request, env, ctx) };
}

export function requestCf(request: Request): Result<unknown, undefined> {
  const cf = request.cf;
  return cf === undefined ? Result$Error(undefined) : Result$Ok(cf);
}
