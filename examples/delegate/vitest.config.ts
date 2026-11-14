import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // Gleam also copies `.ts` files from `test/` into `build/`; only run the
  // originals.
  test: { include: ["test/**/*.spec.ts"] },
});
