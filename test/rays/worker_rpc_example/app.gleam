//// The calling Worker from `rays/worker_rpc`'s module docs, compiled and
//// tested so the example stays correct.

import gleam/javascript/promise.{type Promise}
import gleam/string
import rays/worker.{type Context, type Env, type Request, type Response}
import rays/worker_rpc
import rays/worker_rpc_example/names

pub fn handle_request(
  _request: Request,
  env: Env,
  _ctx: Context,
) -> Promise(Response) {
  case worker_rpc.service(env, "NAMES") {
    Ok(service) -> {
      let call = worker_rpc.call(service, names.search, names.Search("Ad", 2))
      use found <- promise.map(call)
      case found {
        Ok(found) -> worker.ok() |> worker.string_body(string.join(found, ", "))
        Error(_) -> worker.response(502)
      }
    }
    Error(Nil) -> promise.resolve(worker.internal_server_error())
  }
}
