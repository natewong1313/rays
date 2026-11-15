//// The main Worker. It greets whoever the names Worker in
//// `greeter/names` says the visitor is, through the `NAMES` service binding.
//// Both Workers are configured in `cloudflare.config.ts`.

import gleam/http.{Get}
import gleam/http/request
import gleam/javascript/promise.{type Promise}
import gleam/result
import rays/fetch
import rays/workers.{type Context, type Env, type Request, type Response}

pub fn main() -> workers.Worker {
  workers.new(handle_request)
}

pub fn handle_request(
  req: Request,
  env: Env,
  _ctx: Context,
) -> Promise(Response) {
  case workers.path_segments(req) {
    [] -> greet(req, env)
    _ -> promise.resolve(workers.not_found())
  }
}

// GET / — "<GREETING>, <name>!", with the name from the names Worker.
fn greet(req: Request, env: Env) -> Promise(Response) {
  use <- workers.require_method(req, Get)
  let greeting = workers.env_var(env, "GREETING") |> result.unwrap("Hello")
  case fetch.service(env, "NAMES") {
    Error(Nil) -> promise.resolve(workers.internal_server_error())
    Ok(names) -> {
      let ask =
        request.new()
        |> request.set_path("/")
        |> request.set_body(workers.Empty)
      use sent <- promise.await(fetch.send(ask, to: names))
      case sent {
        Error(_) -> promise.resolve(workers.response(502))
        Ok(response) -> {
          use name <- promise.map(fetch.read_text(response))
          case name {
            Ok(name) ->
              workers.ok()
              |> workers.string_body(greeting <> ", " <> name <> "!")
            Error(_) -> workers.response(502)
          }
        }
      }
    }
  }
}
