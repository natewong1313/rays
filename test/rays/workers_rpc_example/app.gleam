//// The calling Worker from `rays/workers_rpc`'s module docs, compiled and
//// tested so the example stays correct.

import gleam/javascript/promise.{type Promise}
import gleam/string
import rays/workers.{type Context, type Env, type Request, type Response}
import rays/workers_rpc
import rays/workers_rpc_example/names

pub fn handle_request(
  _request: Request,
  env: Env,
  _ctx: Context,
) -> Promise(Response) {
  case workers_rpc.service(env, "NAMES") {
    Ok(service) -> {
      let call = workers_rpc.call(service, names.search, names.Search("Ad", 2))
      use found <- promise.map(call)
      case found {
        Ok(found) ->
          workers.ok() |> workers.string_body(string.join(found, ", "))
        Error(_) -> workers.response(502)
      }
    }
    Error(Nil) -> promise.resolve(workers.internal_server_error())
  }
}
