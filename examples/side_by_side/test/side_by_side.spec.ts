// Runs both Workers together, as `pnpm dev` does, and checks that they can
// call each other through their service bindings.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

// The first Worker is the primary one, which receives `server.fetch`.
const server = createTestHarness({
  workers: [
    { configPath: "./web/wrangler.jsonc" },
    { configPath: "./api/wrangler.jsonc" },
  ],
});

beforeAll(() => server.listen());
afterAll(() => server.close());

describe("side by side example", () => {
  it("serves the TypeScript Worker's own routes", async () => {
    const response = await server.fetch("/");
    expect(await response.text()).toBe(
      "Hello from TypeScript! Try /api/greeting.",
    );
  });

  it("calls the Gleam Worker, which calls back to TypeScript", async () => {
    const response = await server.fetch("/api/greeting");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, Joe, from Gleam!");
  });

  it("streams a TypeScript response back through Gleam", async () => {
    const response = await server.fetch("/api/whoami");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Joe");
  });

  it("lets the Gleam Worker answer unknown API routes", async () => {
    const response = await server.fetch("/api/nope");
    expect(response.status).toBe(404);
  });
});
