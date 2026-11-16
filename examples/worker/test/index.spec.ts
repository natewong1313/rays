import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const url = (path: string) => `https://example.com${path}`;

describe("worker example", () => {
  it("serves the home page as HTML", async () => {
    const response = await exports.default.fetch(url("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toContain("Hello from Gleam");
  });

  it("matches path segments", async () => {
    const response = await exports.default.fetch(url("/hello/Joe"));
    expect(await response.text()).toBe("Hello, Joe!");
  });

  it("rejects the wrong method", async () => {
    const response = await exports.default.fetch(url("/hello/Joe"), {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("echoes the request body", async () => {
    const response = await exports.default.fetch(url("/echo"), {
      method: "POST",
      body: "echo me",
    });
    expect(await response.text()).toBe("echo me");
  });

  it("decodes and encodes JSON", async () => {
    const response = await exports.default.fetch(url("/people"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Joe", is_cool: true }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      name: "Joe",
      is_cool: true,
      saved: true,
    });
  });

  it("reads vars from gleam.toml", async () => {
    const response = await exports.default.fetch(url("/greeting"));
    expect(await response.text()).toBe("Hello from Gleam on Cloudflare!");
  });

  it("responds to unknown paths with 404", async () => {
    const response = await exports.default.fetch(url("/nope"));
    expect(response.status).toBe(404);
  });
});
