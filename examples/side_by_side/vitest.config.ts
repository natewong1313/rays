import { defineConfig } from "vitest/config";

// The tests run in Node and start both Workers with Wrangler's test harness.
export default defineConfig({
  test: { include: ["test/**/*.spec.ts"] },
});
