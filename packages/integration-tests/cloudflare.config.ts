// The Worker the tests run in, with every Durable Object class in src/.
import { raysWorker } from "@rays/config/cf";
import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: raysWorker({
    name: "rays-integration-tests",
    compatibilityDate: "2026-09-01",
    exports: {
      Counter: exports.durableObject({ storage: "sqlite" }),
      Notes: exports.durableObject({ storage: "sqlite" }),
      Restless: exports.durableObject({ storage: "sqlite" }),
      Sleepy: exports.durableObject({ storage: "sqlite" }),
    },
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
