//// The calling Worker from `rays/worker_rpc`'s module docs, compiled and
//// tested so the example stays correct.

import gleam/javascript/promise.{type Promise}
import gleam/string
import rays/app
import rays/worker.{type Context, type Env, type Request, type Response}
import rays/worker_rpc
import rays/worker_rpc_example/names

pub fn handle_request(
  _request: Request,
  _env: Env,
  _ctx: Context,
) -> Promise(Response) {
  let call =
    app.connect_worker(names.worker)
    |> worker_rpc.call(names.search, names.Search("Ad", 2))
  use found <- promise.map(call)
  case found {
    Ok(found) -> worker.ok() |> worker.string_body(string.join(found, ", "))
    Error(_) -> worker.response(502)
  }
}
