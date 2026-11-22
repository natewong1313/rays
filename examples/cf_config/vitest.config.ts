import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { rays } from "@rays/config/vite";
import { raysTestWorkers } from "@rays/config/vitest";
import { defineConfig } from "vitest/config";
import cloudflareConfig from "./cloudflare.config.ts";

export default defineConfig({
  plugins: [
    rays(),
    // Runs the main Worker from cloudflare.config.ts. `raysTestWorkers` builds
    // the names Worker it binds, so the tests call the real one over Workers
    // RPC.
    cloudflareTest(async () => ({
      config: true,
      miniflare: { workers: await raysTestWorkers(cloudflareConfig) },
    })),
  ],
  // Gleam also copies `.ts` files from `test/` into `build/`; only run the
  // originals.
  test: { include: ["test/**/*.spec.ts"] },
});
