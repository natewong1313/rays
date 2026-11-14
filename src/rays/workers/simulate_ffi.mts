// FFI shim for `rays/workers/simulate`: stand-in requests, `env`, and `ctx`.
//
// You should probably use integration tests using Vitest.

import { BitArray$BitArray$data } from "../../gleam.mjs";
import type { BitArray } from "../../gleam.mjs";

const PLACEHOLDER_URL = "https://simulate.invalid/";

export function emptyRequest(): Request {
  return new Request(PLACEHOLDER_URL);
}

export function textRequest(body: string): Request {
  return new Request(PLACEHOLDER_URL, { method: "POST", body });
}

export function bytesRequest(body: BitArray): Request {
  const view = BitArray$BitArray$data(body);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return new Request(PLACEHOLDER_URL, { method: "POST", body: bytes });
}

export type Env = Record<string, unknown>;

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
