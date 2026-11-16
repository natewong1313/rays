import { cloudflare } from "@cloudflare/vite-plugin";
import { rays } from "@rays/core/vite";
import { defineConfig } from "vite";
import { namesWorker } from "./cloudflare.config.ts";

export default defineConfig({
  // `rays()` builds the Gleam project and provides `virtual:rays/worker`.
  // The main Worker comes from cloudflare.config.ts; the names Worker runs
  // beside it.
  plugins: [
    rays(),
    cloudflare({ auxiliaryWorkers: [{ config: namesWorker }] }),
  ],
});
