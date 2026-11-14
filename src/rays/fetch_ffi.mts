// FFI shim over the Fetch API `Request` and `Response` classes.
import {
  BitArray$BitArray,
  BitArray$BitArray$data,
  Result$Error,
  Result$Ok,
} from "../gleam.mjs";
import type { BitArray, Result } from "../gleam.mjs";

export type Header = [string, string];

export function requestMethod(request: Request): string {
  return request.method;
}

export function requestUrl(request: Request): string {
  return request.url;
}

export function requestHeaders(request: Request): Header[] {
  return [...request.headers];
}

export function requestBodyStream(
  request: Request,
): Result<ReadableStream, undefined> {
  if (request.body === null || request.bodyUsed) {
    return Result$Error(undefined);
  }
  return Result$Ok(request.body);
}

export async function readBytes(
  request: Request,
): Promise<Result<BitArray, string>> {
  if (request.bodyUsed) {
    return Result$Error("already_read");
  }

  try {
    const buffer = await request.arrayBuffer();
    return Result$Ok(BitArray$BitArray(new Uint8Array(buffer)));
  } catch {
    return Result$Error("read_failed");
  }
}

function init(status: number, headers: Header[]): ResponseInit {
  const h = new Headers();
  // `append` rather than `set` so repeated headers such as set-cookie survive.
  for (const [name, value] of headers) h.append(name, value);
  return { status, headers: h };
}

function make(
  status: number,
  headers: Header[],
  body: BodyInit | null,
): Response {
  return new Response(body, init(status, headers));
}

export function textResponse(
  status: number,
  headers: Header[],
  body: string,
): Response {
  return make(status, headers, body);
}

export function bytesResponse(
  status: number,
  headers: Header[],
  body: BitArray,
): Response {
  const view = BitArray$BitArray$data(body);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return make(status, headers, bytes);
}

export function streamResponse(
  status: number,
  headers: Header[],
  body: ReadableStream,
): Response {
  return make(status, headers, body);
}

export function emptyResponse(status: number, headers: Header[]): Response {
  return make(status, headers, null);
}
