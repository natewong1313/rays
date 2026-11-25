import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("cf_config example", () => {
  it("greets the visitor the names Worker finds, over Workers RPC", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, Dr Joe!");
  });

  it("has the names Worker refuse a call from a different version", async () => {
    // A call the way rays/worker_rpc makes one, from a Worker built from
    // different types.
    const names = (env as unknown as Record<string, any>).NAMES;
    const reply = await names.find_visitor({
      m: "greeter/names",
      v: "0000000000000000",
      args: undefined,
    });
    expect(reply).toEqual({ error: "version_mismatch" });
  });
});
