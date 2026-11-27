// Every Worker of the app comes from `pub fn app()` in src/greeter.gleam.
// `raysApp()` calls it and configures each Worker it registers, with the
// bindings between them and to the Durable Object class, named the way
// `rays/app` finds them, so neither this file nor the Gleam code names a
// binding. Only what isn't a resource of the app, such as a text variable,
// is given here, by the name in the Worker's `app.Worker` constant.
import { raysApp } from "@rays/config/app";
import { bindings, defineConfig } from "cf/config";

const app = await raysApp({
  compatibilityDate: "2026-09-01",
  workers: { front: { env: { GREETING: bindings.text("Hello") } } },
});

// For vite.config.ts, which runs them beside the main Worker.
export const auxiliaryWorkers = app.auxiliary;

export default defineConfig({ worker: app.main });
