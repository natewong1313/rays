//// The Gleam Worker, running beside a TypeScript Worker.
////
//// The TypeScript Worker sends it every request under `/api/` through a
//// service binding. To find out who the user is, this Worker asks the
//// TypeScript Worker in turn, through its own `WEB` service binding.

import gleam/http.{Get}
import gleam/http/request
import gleam/javascript/promise.{type Promise}
import gleam/result
import rays/fetch.{type Target}
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
    ["api", "greeting"] -> greeting(req, env)
    ["api", "whoami"] -> whoami(req, env)
    _ -> promise.resolve(workers.not_found())
  }
}

// GET /api/greeting — greets the user by the name the TypeScript Worker
// gives.
fn greeting(req: Request, env: Env) -> Promise(Response) {
  use <- workers.require_method(req, Get)
  use web <- require_service(env, "WEB")
  use result <- promise.await(fetch.send(get("/whoami"), to: web))
  case result {
    Error(_) -> promise.resolve(workers.response(502))
    Ok(response) -> {
      use name <- promise.map(fetch.read_text(response))
      case name {
        Ok(name) ->
          workers.ok()
          |> workers.string_body("Hello, " <> name <> ", from Gleam!")
        Error(_) -> workers.response(502)
      }
    }
  }
}

// GET /api/whoami — passes the TypeScript Worker's answer straight on,
// without reading it.
fn whoami(req: Request, env: Env) -> Promise(Response) {
  use <- workers.require_method(req, Get)
  use web <- require_service(env, "WEB")
  use result <- promise.map(fetch.send(get("/whoami"), to: web))
  case result {
    Ok(response) ->
      fetch.forward(response)
      |> result.unwrap(workers.internal_server_error())
    Error(_) -> workers.response(502)
  }
}

/// Get the service binding with the given name, responding with 500:
/// Internal server error if it is not configured.
///
fn require_service(
  env: Env,
  name: String,
  next: fn(Target) -> Promise(Response),
) -> Promise(Response) {
  case fetch.service(env, name) {
    Ok(target) -> next(target)
    Error(_) -> promise.resolve(workers.internal_server_error())
  }
}

/// A `GET` request for the given path. A service binding ignores the host.
///
fn get(path: String) -> request.Request(workers.Body) {
  request.new()
  |> request.set_path(path)
  |> request.set_body(workers.Empty)
}
