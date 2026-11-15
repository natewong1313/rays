//// The names Worker. The main Worker calls it through a service binding to
//// find out who the visitor is.

import gleam/javascript/promise.{type Promise}
import rays/workers.{type Context, type Env, type Request, type Response}

pub fn main() -> workers.Worker {
  workers.new(handle_request)
}

pub fn handle_request(
  _req: Request,
  _env: Env,
  _ctx: Context,
) -> Promise(Response) {
  workers.ok()
  |> workers.string_body("Joe")
  |> promise.resolve
}
