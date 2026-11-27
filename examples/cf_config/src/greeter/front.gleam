//// The main Worker. It greets whoever the names Worker says the visitor is,
//// by calling its `find_visitor` method over Workers RPC, and counts visits
//// with the `visit_counter` Durable Object class, which the names Worker
//// hosts. It reaches both through `rays/app`, by the names Worker's
//// constant and by the class's function, never by a binding name.

import gleam/http.{Get, Post}
import gleam/int
import gleam/javascript/promise.{type Promise}
import gleam/option.{None, Some}
import gleam/result
import greeter/names.{Visitor}
import greeter/visit_counter
import rays/app
import rays/durable_object
import rays/worker.{type Context, type Env, type Request, type Response}
import rays/worker_rpc

/// The main Worker, for the app to register.
pub const worker = app.Worker("front", entrypoint: main)

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
    ["visits"] -> record_visit(req)
    _ -> promise.resolve(worker.not_found())
  }
}

// GET / — "<GREETING>, <title> <name>!", with the visitor from the names
// Worker.
fn greet(req: Request, env: Env) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  let greeting = worker.env_var(env, "GREETING") |> result.unwrap("Hello")

  let visitor =
    app.connect_worker(names.worker)
    |> worker_rpc.call(names.find_visitor, Nil)
  use visitor <- promise.map(visitor)
  case visitor {
    Ok(visitor) ->
      worker.ok()
      |> worker.string_body(greeting <> ", " <> full_name(visitor) <> "!")
    // This Worker has no binding to the names Worker: it is misconfigured.
    Error(worker_rpc.NotConfigured(..)) -> worker.internal_server_error()
    Error(_) -> worker.response(502)
  }
}

// POST /visits — counts a visit, replying with how many there have been.
fn record_visit(req: Request) -> Promise(Response) {
  use <- worker.require_method(req, Post)
  case app.connect_durable_object(visit_counter.visit_counter) {
    Error(Nil) -> promise.resolve(worker.internal_server_error())
    Ok(counters) -> {
      let counter = durable_object.get_by_name(counters, "everyone")
      use count <- promise.map(durable_object.call(
        counter,
        visit_counter.record_visit,
        Nil,
      ))
      case count {
        Ok(count) -> worker.ok() |> worker.string_body(int.to_string(count))
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
