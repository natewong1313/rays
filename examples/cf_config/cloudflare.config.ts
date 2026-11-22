// Both Workers come from this one Gleam project. `raysWorker()` sets each
// one's entrypoint to the Worker built by `pub fn main()` in a Gleam module:
// the module named after the package (src/greeter.gleam) unless `module`
// says otherwise.
import { raysWorker } from "@rays/config/cf";
import { bindings, defineConfig } from "cf/config";

const compatibilityDate = "2026-09-01";

// Exported so the main Worker's binding, and vite.config.ts, can use it.
export const namesWorker = raysWorker(
  { name: "rays-cf-config-names", compatibilityDate },
  { module: "greeter/names" },
);

export default defineConfig({
  worker: raysWorker({
    name: "rays-cf-config",
    compatibilityDate,
    env: {
      GREETING: bindings.text("Hello"),
      NAMES: bindings.worker({ worker: namesWorker }),
    },
  }),
});
