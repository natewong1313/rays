//// The part of the Worker written in Gleam. The TypeScript entry module,
//// `index.ts`, sends it every request under `/gleam/`, unchanged, so paths
//// here still start with `gleam`.

import gleam/http.{Get}
import gleam/javascript/promise.{type Promise}
import rays/workers.{type Context, type Env, type Request, type Response}

pub fn main() -> workers.Worker {
  workers.new(handle_request)
}

fn handle_request(req: Request, _env: Env, _ctx: Context) -> Promise(Response) {
  case workers.path_segments(req) {
    ["gleam", "hello", name] -> hello(req, name)
    _ -> promise.resolve(workers.not_found())
  }
}

// GET /gleam/hello/:name
fn hello(req: Request, name: String) -> Promise(Response) {
  use <- workers.require_method(req, Get)
  workers.ok()
  |> workers.string_body("Hello, " <> name <> ", from Gleam!")
  |> promise.resolve
}
