import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Compiles the fixture project that the tests copy, once per run.
    globalSetup: ["./test/global-setup.ts"],
  },
  resolve: {
    alias: {
      // Entry modules for Workers with RPC methods import it; see the stub.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
