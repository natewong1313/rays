//// The part of the Worker written in Gleam. The TypeScript entry module,
//// `index.ts`, sends it every request under `/gleam/`, unchanged, so paths
//// here still start with `gleam`.

import gleam/http.{Get}
import gleam/javascript/promise.{type Promise}
import rays/worker.{type Context, type Env, type Request, type Response}

pub fn main() -> worker.Worker {
  worker.new(handle_request)
}

fn handle_request(req: Request, _env: Env, _ctx: Context) -> Promise(Response) {
  case worker.path_segments(req) {
    ["gleam", "hello", name] -> hello(req, name)
    _ -> promise.resolve(worker.not_found())
  }
}

// GET /gleam/hello/:name
fn hello(req: Request, name: String) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  worker.ok()
  |> worker.string_body("Hello, " <> name <> ", from Gleam!")
  |> promise.resolve
}
