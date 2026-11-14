// FFI shim for `rays/workers/simulate`: stand-in requests, `env`, and `ctx`.
//
// Only the body of a simulated `Request` is read by `rays/workers`; its method,
// URL, and headers come from the Gleam request record. The placeholder URL and
// `POST` method exist because the Fetch API requires a URL and forbids a body
// on `GET` requests.

import type { BitArray } from "../../gleam.mjs";
import { toUint8Array } from "../workers_ffi.mts";
import type { Env } from "../workers_ffi.mts";

const PLACEHOLDER_URL = "https://simulate.invalid/";

export function emptyRequest(): Request {
  return new Request(PLACEHOLDER_URL);
}

export function textRequest(body: string): Request {
  return new Request(PLACEHOLDER_URL, { method: "POST", body });
}

export function bytesRequest(body: BitArray): Request {
  return new Request(PLACEHOLDER_URL, {
    method: "POST",
    body: toUint8Array(body),
  });
}

export function emptyEnv(): Env {
  return {};
}

export function envWith(env: Env, name: string, value: unknown): Env {
  return { ...env, [name]: value };
}

// Only the members `rays/workers` uses.
export type SimulatedContext = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException"
>;

export function context(): SimulatedContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}
