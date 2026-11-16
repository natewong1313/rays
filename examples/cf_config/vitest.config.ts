import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { rays } from "@rays/core/vite";
import { defineConfig } from "vitest/config";
import { namesWorker } from "./cloudflare.config.ts";

export default defineConfig({
  plugins: [
    rays(),
    cloudflareTest({
      // Runs the main Worker from cloudflare.config.ts.
      config: true,
      // Only the main Worker is built with Vite here, so the names Worker it
      // calls is a stand-in. The real one is tested in test/greeter_test.gleam.
      miniflare: {
        workers: [
          {
            name: namesWorker.name,
            modules: true,
            script:
              'export default { fetch: () => new Response("Joe from the stand-in") };',
          },
        ],
      },
    }),
  ],
  // Gleam also copies `.ts` files from `test/` into `build/`; only run the
  // originals.
  test: { include: ["test/**/*.spec.ts"] },
});
