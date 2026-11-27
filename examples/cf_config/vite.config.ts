import { cloudflare } from "@cloudflare/vite-plugin";
import { rays } from "@rays/config/vite";
import { defineConfig } from "vite";
import { auxiliaryWorkers } from "./cloudflare.config.ts";

export default defineConfig({
  // `rays()` builds the Gleam project and provides `virtual:rays/worker`.
  // The main Worker comes from cloudflare.config.ts; the app's other Workers
  // run beside it.
  plugins: [
    rays(),
    cloudflare({
      auxiliaryWorkers: auxiliaryWorkers.map((config) => ({ config })),
    }),
  ],
});
