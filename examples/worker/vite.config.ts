import { cloudflare } from "@cloudflare/vite-plugin";
import { rays } from "@rays/core/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [rays({ module: "worker" }), cloudflare()],
});
