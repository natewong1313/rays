import gleam/http.{Get}
import gleam/javascript/promise.{type Promise}
import gleam/result
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
    [] -> hello(req, env, "world")
    [name] -> hello(req, env, name)
    _ -> promise.resolve(workers.not_found())
  }
}

// GET / and GET /:name, greeting with the GREETING variable from gleam.toml.
fn hello(req: Request, env: Env, name: String) -> Promise(Response) {
  use <- workers.require_method(req, Get)
  let greeting = workers.env_var(env, "GREETING") |> result.unwrap("Hello")
  workers.ok()
  |> workers.string_body(greeting <> ", " <> name <> "!")
  |> promise.resolve
}
