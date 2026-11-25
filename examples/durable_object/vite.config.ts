import { cloudflare } from "@cloudflare/vite-plugin";
import { rays } from "@rays/config/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // `rays()` builds the Gleam project and provides `virtual:rays/worker`,
  // which exports the Worker and its Durable Object classes.
  plugins: [rays(), cloudflare()],
});
