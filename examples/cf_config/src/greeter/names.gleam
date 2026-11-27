//// The names Worker. The main Worker calls its `find_visitor` method over
//// Workers RPC, through a service binding, to find out who the visitor is.

import gleam/javascript/promise.{type Promise}
import gleam/option.{type Option, Some}
import rays/app
import rays/worker.{type Context, type Env, type Request, type Response}
import rays/worker_rpc

/// The names Worker, for the app to register and other Workers to reach.
pub const worker = app.Worker("names", entrypoint: main)

pub fn main() -> worker.Worker {
  worker.new(handle_request)
  |> worker_rpc.bind(find_visitor)
}

pub fn handle_request(
  _req: Request,
  _env: Env,
  _ctx: Context,
) -> Promise(Response) {
  promise.resolve(worker.not_found())
}

/// Who is visiting, with their title if they have one.
pub type Visitor {
  Visitor(name: String, title: Option(String))
}

/// Find the visitor. Another Worker calls this with
/// `worker_rpc.call(service, names.find_visitor, Nil)`.
pub fn find_visitor(_params: worker_rpc.Params(Nil)) -> Promise(Visitor) {
  promise.resolve(Visitor(name: "Joe", title: Some("Dr")))
}
