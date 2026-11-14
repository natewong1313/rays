import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const url = (path: string) => `https://example.com${path}`;

describe("delegate example", () => {
  it("handles its own routes in TypeScript", async () => {
    const response = await exports.default.fetch(url("/"));
    expect(await response.text()).toBe("Hello from TypeScript!");
  });

  it("sends /gleam/ routes to Gleam", async () => {
    const response = await exports.default.fetch(url("/gleam/hello/Joe"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, Joe, from Gleam!");
  });

  it("lets Gleam reject the wrong method", async () => {
    const response = await exports.default.fetch(url("/gleam/hello/Joe"), {
      method: "POST",
    });
    expect(response.status).toBe(405);
  });

  it("lets Gleam answer unknown /gleam/ routes", async () => {
    const response = await exports.default.fetch(url("/gleam/nope"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
