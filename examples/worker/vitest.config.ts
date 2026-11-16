import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // The configuration rays writes from [tools.rays] in gleam.toml. Run
    // `rays build` first; `pnpm test` does.
    cloudflareTest({ wrangler: { configPath: "./.rays/wrangler.jsonc" } }),
  ],
  // Gleam also copies `.ts` files from `test/` into `build/`; only run the
  // originals.
  test: { include: ["test/**/*.spec.ts"] },
});
