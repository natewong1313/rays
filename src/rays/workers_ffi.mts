// FFI shim between the Cloudflare Workers runtime and `rays/workers`: the
// exported handler, the Worker's bindings (`env`) and `ExecutionContext`, and
// the Fetch API `Request` and `Response` classes.
//
// Decisions such as which statuses may carry a body are made in Gleam; these
// functions only convert between Gleam and JavaScript values.

import {
  BitArray$BitArray,
  BitArray$BitArray$data,
  Result$Error,
  Result$Ok,
} from "../gleam.mjs";
import type { BitArray, Result } from "../gleam.mjs";

export type Env = Record<string, unknown>;

export type Header = [string, string];

// `ExportedHandler` and others are from `@cloudflare/workers-types`.
export function makeWorker(
  fetch: ExportedHandlerFetchHandler<Env>,
): ExportedHandler<Env> {
  return { fetch };
}

// The bytes of an aligned bit array, without copying.
export function toUint8Array(bits: BitArray): Uint8Array {
  const view = BitArray$BitArray$data(bits);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// Env & Context

export function envVar(env: Env, name: string): Result<string, undefined> {
  const value = env[name];
  return typeof value === "string" ? Result$Ok(value) : Result$Error(undefined);
}

export function envBinding(env: Env, name: string): Result<unknown, undefined> {
  const value = env[name];
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

// Requests

export function requestMethod(request: Request): string {
  return request.method;
}

export function requestUrl(request: Request): string {
  return request.url;
}

export function requestHeaders(request: Request): Header[] {
  return [...request.headers];
}

export function requestCf(request: Request): Result<unknown, undefined> {
  const cf = request.cf;
  return cf === undefined ? Result$Error(undefined) : Result$Ok(cf);
}

export function bodyUsed(request: Request): boolean {
  return request.bodyUsed;
}

export function bodyStream(request: Request): ReadableStream {
  return request.body ?? new ReadableStream({ start: (c) => c.close() });
}

// Resolves to the error's message if the body cannot be read.
export async function readBytes(
  request: Request,
): Promise<Result<BitArray, string>> {
  try {
    const buffer = await request.arrayBuffer();
    return Result$Ok(BitArray$BitArray(new Uint8Array(buffer)));
  } catch (error) {
    return Result$Error(error instanceof Error ? error.message : String(error));
  }
}

// Responses

function init(status: number, headers: Header[]): ResponseInit {
  const h = new Headers();
  // `append` rather than `set` so repeated headers such as set-cookie survive.
  for (const [name, value] of headers) h.append(name, value);
  return { status, headers: h };
}

export function textResponse(
  status: number,
  headers: Header[],
  body: string,
): Response {
  return new Response(body, init(status, headers));
}

export function bytesResponse(
  status: number,
  headers: Header[],
  body: BitArray,
): Response {
  return new Response(toUint8Array(body), init(status, headers));
}

export function streamResponse(
  status: number,
  headers: Header[],
  body: ReadableStream,
): Response {
  return new Response(body, init(status, headers));
}

export function emptyResponse(status: number, headers: Header[]): Response {
  return new Response(null, init(status, headers));
}
