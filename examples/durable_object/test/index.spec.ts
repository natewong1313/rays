import { evictDurableObject } from "cloudflare:test";
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

  it("keeps its messages in its database when it is evicted", async () => {
    await post("/rooms/kept", "before");
    const room = (exports as unknown as Record<string, DurableObjectNamespace>)
      .ChatRoom!.getByName("kept");
    await evictDurableObject(room);
    expect(await text(post("/rooms/kept", "after"))).toBe("2");
    expect(await text(get("/rooms/kept"))).toBe("after\nbefore");
  });

  it("is one instance per name", async () => {
    await post("/rooms/one", "in one");
    expect(await text(get("/rooms/two"))).toBe("");
  });
});
