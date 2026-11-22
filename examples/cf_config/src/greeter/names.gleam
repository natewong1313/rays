//// The names Worker. The main Worker calls its `find_visitor` method over
//// Workers RPC, through a service binding, to find out who the visitor is.

import gleam/javascript/promise.{type Promise}
import gleam/option.{type Option, Some}
import rays/workers.{type Context, type Env, type Request, type Response}
import rays/workers_rpc

pub fn main() -> workers.Worker {
  workers.new(handle_request)
  |> workers_rpc.bind(find_visitor)
}

pub fn handle_request(
  _req: Request,
  _env: Env,
  _ctx: Context,
) -> Promise(Response) {
  promise.resolve(workers.not_found())
}

/// Who is visiting, with their title if they have one.
pub type Visitor {
  Visitor(name: String, title: Option(String))
}

/// Find the visitor. Another Worker calls this with
/// `workers_rpc.call(service, names.find_visitor, Nil)`.
pub fn find_visitor(_params: workers_rpc.Params(Nil)) -> Promise(Visitor) {
  promise.resolve(Visitor(name: "Joe", title: Some("Dr")))
}
