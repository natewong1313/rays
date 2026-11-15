import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("cf_config example", () => {
  it("greets the visitor the names Worker names, through the binding", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, Joe from the stand-in!");
  });
});
