// Drive a Worker through the real Fetch API `Request` and `Response` classes,
// the same way the Workers runtime does.

import { Result$Error, Result$Ok } from "../gleam.mjs";
import type { Result } from "../gleam.mjs";
import type { Header } from "../rays/fetch_ffi.mts";
import type { SimulatedContext } from "../rays/workers/simulate_ffi.mts";

export function request(
  method: string,
  url: string,
  headers: Header[],
  body: string,
): Request {
  return new Request(url, { method, headers, body: body === "" ? null : body });
}

type TestableWorker = {
  fetch(
    request: Request,
    env: unknown,
    ctx: SimulatedContext,
  ): Promise<Response>;
};

export async function run(
  worker: TestableWorker,
  request: Request,
): Promise<[Response, number, boolean]> {
  const waited: Promise<unknown>[] = [];
  let passedThrough = false;
  const ctx: SimulatedContext = {
    waitUntil: (promise) => void waited.push(promise),
    passThroughOnException: () => void (passedThrough = true),
  };
  const response = await worker.fetch(request, {}, ctx);
  await Promise.all(waited);
  return [response, waited.length, passedThrough];
}

export function status(response: Response): number {
  return response.status;
}

export function header(
  response: Response,
  name: string,
): Result<string, undefined> {
  const value = response.headers.get(name);
  return value === null ? Result$Error(undefined) : Result$Ok(value);
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

export function hasBody(response: Response): boolean {
  return response.body !== null;
}

export function text(response: Response): Promise<string> {
  return response.text();
}
