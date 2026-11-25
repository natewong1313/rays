//// The main Worker. It greets whoever the names Worker in
//// `greeter/names` says the visitor is, by calling its `find_visitor`
//// method over Workers RPC through the `NAMES` service binding. Both Workers
//// are configured in `cloudflare.config.ts`.

import gleam/http.{Get}
import gleam/javascript/promise.{type Promise}
import gleam/option.{None, Some}
import gleam/result
import greeter/names.{Visitor}
import rays/worker.{type Context, type Env, type Request, type Response}
import rays/worker_rpc

pub fn main() -> worker.Worker {
  worker.new(handle_request)
}

pub fn handle_request(
  req: Request,
  env: Env,
  _ctx: Context,
) -> Promise(Response) {
  case worker.path_segments(req) {
    [] -> greet(req, env)
    _ -> promise.resolve(worker.not_found())
  }
}

// GET / — "<GREETING>, <title> <name>!", with the visitor from the names
// Worker.
fn greet(req: Request, env: Env) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  let greeting = worker.env_var(env, "GREETING") |> result.unwrap("Hello")

  case worker_rpc.service(env, "NAMES") {
    Error(Nil) -> promise.resolve(worker.internal_server_error())
    Ok(service) -> {
      use visitor <- promise.map(worker_rpc.call(
        service,
        names.find_visitor,
        Nil,
      ))
      case visitor {
        Ok(visitor) ->
          worker.ok()
          |> worker.string_body(greeting <> ", " <> full_name(visitor) <> "!")
        Error(_) -> worker.response(502)
      }
    }
  }
}

fn full_name(visitor: names.Visitor) -> String {
  case visitor {
    Visitor(name:, title: Some(title)) -> title <> " " <> name
    Visitor(name:, title: None) -> name
  }
}
