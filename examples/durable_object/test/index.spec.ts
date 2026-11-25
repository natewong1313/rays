import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const get = (path: string) => exports.default.fetch(`https://example.com${path}`);
const post = (path: string, body: string) =>
  exports.default.fetch(`https://example.com${path}`, { method: "POST", body });
const text = async (response: Promise<Response>) => (await response).text();

describe("a chat room", () => {
  it("keeps its messages between calls", async () => {
    expect(await text(post("/rooms/general", "hello"))).toBe("1");
    expect(await text(post("/rooms/general", "again"))).toBe("2");
    expect(await text(get("/rooms/general"))).toBe("again\nhello");
  });

  it("is one instance per name", async () => {
    await post("/rooms/one", "in one");
    expect(await text(get("/rooms/two"))).toBe("");
  });
});
