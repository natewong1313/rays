//// The app: its Workers, and the Durable Object class one of them hosts.
//// `raysApp()` in `cloudflare.config.ts` reads it to configure them: the
//// names Worker hosts the class, the main Worker is bound to the names
//// Worker, and both are bound to the class.

import greeter/front
import greeter/names
import greeter/visit_counter
import rays/app.{type App}

pub fn app() -> App {
  app.new("rays-cf-config", main: front.worker)
  |> app.register_worker(names.worker)
  |> app.register_durable_object(
    visit_counter.visit_counter,
    hosted_by: names.worker,
  )
}
