// FFI shim for `rays/fetch`: building outgoing Fetch API `Request`s, sending
// them to the global `fetch` or a service binding, and reading the
// `Response`s that come back.
//
// Failures are returned as values. Classifying them into `SendError`
// variants is done in Gleam.

import { Result$Error, Result$Ok } from "../gleam.mjs";
import type { BitArray, Result } from "../gleam.mjs";
import { describeError, toUint8Array } from "./worker_ffi.mts";
import type { Env, Header } from "./worker_ffi.mts";

// Anything with a Fetch-compatible `fetch` method: the global `fetch`, or a
// service binding.
export type Fetcher = { fetch(request: Request): Promise<Response> };

// The name and message of a thrown error, for Gleam to classify.
type Failure = [string, string];

// Targets

// Looks up `fetch` on each call, so it can be replaced after this module has
// loaded, for example by a test.
export function globalFetcher(): Fetcher {
  return { fetch: (request) => globalThis.fetch(request) };
}

export function serviceBinding(
  env: Env,
  name: string,
): Result<Fetcher, undefined> {
  const value = env[name];
  const isFetcher =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { fetch?: unknown }).fetch === "function";
  return isFetcher ? Result$Ok(value as Fetcher) : Result$Error(undefined);
}

// Requests

// Resolves to the error's message if the Fetch API rejects the request, for
// example because the URL is invalid or a `GET` request has a body.
function build(
  method: string,
  url: string,
  headers: Header[],
  body: BodyInit | null,
): Result<Request, string> {
  try {
    const h = new Headers();
    for (const [name, value] of headers) h.append(name, value);
    // Node requires `duplex` for stream bodies; Cloudflare's `RequestInit`
    // type lacks it, so the init is not written inline as an object literal.
    const init = { method, headers: h, body, duplex: "half" };
    return Result$Ok(new Request(url, init));
  } catch (error) {
    return Result$Error(describeError(error, "Unknown error")[1]);
  }
}

export function textRequest(
  method: string,
  url: string,
  headers: Header[],
  body: string,
): Result<Request, string> {
  return build(method, url, headers, body);
}

export function bytesRequest(
  method: string,
  url: string,
  headers: Header[],
  body: BitArray,
): Result<Request, string> {
  return build(method, url, headers, toUint8Array(body));
}

export function streamRequest(
  method: string,
  url: string,
  headers: Header[],
  body: ReadableStream,
): Result<Request, string> {
  return build(method, url, headers, body);
}

export function emptyRequest(
  method: string,
  url: string,
  headers: Header[],
): Result<Request, string> {
  return build(method, url, headers, null);
}

// Resolves to the thrown error's name and message if the request fails,
// whether `fetch` throws synchronously or rejects.
export async function send(
  fetcher: Fetcher,
  request: Request,
): Promise<Result<Response, Failure>> {
  let response: Response;
  try {
    response = await fetcher.fetch(request);
  } catch (error) {
    return Result$Error(describeError(error, "Unknown error"));
  }
  return Result$Ok(response);
}

// Responses

export function responseStatus(response: Response): number {
  return response.status;
}

export function responseHeaders(response: Response): Header[] {
  return [...response.headers];
}

export function responseBodyUsed(response: Response): boolean {
  return response.bodyUsed;
}

// The response's body stream, or an error if it has no body.
export function responseBody(
  response: Response,
): Result<ReadableStream, undefined> {
  const body = response.body;
  return body === null ? Result$Error(undefined) : Result$Ok(body);
}
