// Runs the Worker with the settings from [tools.rays] in gleam.toml.

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const url = (path: string) => `https://example.com${path}`;

describe("managed example", () => {
  it("greets with GREETING from gleam.toml", async () => {
    const response = await exports.default.fetch(url("/Joe"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, Joe!");
  });

  it("greets the world by default", async () => {
    const response = await exports.default.fetch(url("/"));
    expect(await response.text()).toBe("Hello, world!");
  });

  it("only answers GET", async () => {
    const response = await exports.default.fetch(url("/"), { method: "POST" });
    expect(response.status).toBe(405);
  });
});
