import gleam/dynamic/decode
import gleam/http.{Get, Post}
import gleam/javascript/promise.{type Promise}
import gleam/json
import rays/worker.{type Context, type Env, type Request, type Response}

pub fn main() -> worker.Worker {
  worker.new(handle_request)
}

fn handle_request(req: Request, env: Env, ctx: Context) -> Promise(Response) {
  case worker.path_segments(req) {
    [] -> home(req)
    ["hello", name] -> hello(req, name)
    ["echo"] -> echo_body(req)
    ["people"] -> create_person(req)
    ["greeting"] -> greeting(req, env)
    ["background"] -> background(req, ctx)
    _ -> promise.resolve(worker.not_found())
  }
}

fn home(req: Request) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  worker.ok()
  |> worker.html_body("<h1>Hello from Gleam on Cloudflare Workers!</h1>")
  |> promise.resolve
}

// GET /hello/:name
fn hello(req: Request, name: String) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  worker.ok()
  |> worker.string_body("Hello, " <> name <> "!")
  |> promise.resolve
}

// POST /echo — responds with the request body.
fn echo_body(req: Request) -> Promise(Response) {
  use <- worker.require_method(req, Post)
  use body <- worker.require_string_body(req)
  worker.ok()
  |> worker.string_body(body)
  |> promise.resolve
}

type Person {
  Person(name: String, is_cool: Bool)
}

fn person_decoder() -> decode.Decoder(Person) {
  use name <- decode.field("name", decode.string)
  use is_cool <- decode.field("is_cool", decode.bool)
  decode.success(Person(name:, is_cool:))
}

// POST /people with a JSON body like {"name": "Joe", "is_cool": true}
fn create_person(req: Request) -> Promise(Response) {
  use <- worker.require_method(req, Post)
  use value <- worker.require_json(req)
  case decode.run(value, person_decoder()) {
    Ok(person) ->
      json.object([
        #("name", json.string(person.name)),
        #("is_cool", json.bool(person.is_cool)),
        #("saved", json.bool(True)),
      ])
      |> worker.json_response(201)
    Error(_) -> worker.unprocessable_content()
  }
  |> promise.resolve
}

// GET /greeting — reads the GREETING var from wrangler.jsonc.
fn greeting(req: Request, env: Env) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  case worker.env_var(env, "GREETING") {
    Ok(greeting) -> worker.ok() |> worker.string_body(greeting)
    Error(_) -> worker.internal_server_error()
  }
  |> promise.resolve
}

// GET /background — responds immediately, and keeps working afterwards.
fn background(req: Request, ctx: Context) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  worker.wait_until(ctx, promise.wait(100))
  promise.resolve(worker.accepted())
}
