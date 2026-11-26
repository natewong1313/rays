// Tests `handler()` against a real Worker built by `rays/worker`. Run
// `gleam build` in the repository root first; the root `pnpm build` does.

import type { ExecutionContext } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { handler } from "./runtime.ts";
// The compiled `rays/worker` module. `new` is a reserved word in
// JavaScript, so Gleam exports `worker.new` as `new$`.
import { new$, ok } from "../../../build/dev/javascript/rays/rays/worker.mjs";

// Only the members a `rays` Worker uses; the runtime type has more.
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function gleamWorker(): unknown {
  return new$(() => Promise.resolve(ok()));
}

describe("handler", () => {
  it("returns the Worker unchanged", () => {
    const worker = gleamWorker();
    expect(handler(worker)).toBe(worker);
  });

  it("handles requests through the Worker", async () => {
    const app = handler<{ GREETING: string }>(gleamWorker());
    const request = new Request("https://example.com/");
    const response = await app.fetch(
      request as Parameters<typeof app.fetch>[0],
      { GREETING: "hi" },
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("explains that main must be called", () => {
    expect(() => handler(gleamWorker)).toThrow(
      "handler() expects a rays Worker, the result of calling a Gleam main(), but got a function. Did you mean handler(main())?",
    );
  });

  it("rejects objects that are not rays Workers", () => {
    const fetchOnly = { fetch: () => new Response() };
    expect(() => handler(fetchOnly)).toThrow("but got a different object.");
    expect(() => handler(null)).toThrow("but got null.");
    expect(() => handler(undefined)).toThrow("but got undefined.");
  });
});
