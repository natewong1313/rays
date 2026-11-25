import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { rays } from "@rays/config/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Runs the Worker from cloudflare.config.ts, with its Durable Object
  // classes, in workerd.
  plugins: [rays(), cloudflareTest({ config: true })],
  test: { include: ["test/**/*.spec.ts"] },
});
