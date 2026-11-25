// The Worker the tests run in. `raysWorker()` declares every Durable Object
// class in src/ in its `exports`.
import { raysWorker } from "@rays/config/cf";
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: raysWorker({
    name: "rays-integration-tests",
    compatibilityDate: "2026-09-01",
    env: {
      // Tests reach most classes through `ctx.exports`; this one is for the
      // tests of bindings.
      COUNTERS: bindings.durableObject({
        worker: "rays-integration-tests",
        exportName: "Counter",
      }),
    },
  }),
});
