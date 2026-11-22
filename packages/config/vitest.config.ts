import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Compiles the fixture project that the tests copy, once per run.
    globalSetup: ["./test/global-setup.ts"],
  },
});
