//// Unit tests for both Workers, run with `gleam test`. The main Worker's
//// `NAMES` binding is wired to the real names Worker, so these test the two
//// together without the Workers runtime.

import gleam/http
import gleam/javascript/promise.{type Promise}
import gleeunit
import greeter
import greeter/names
import rays/workers.{type Response}
import rays/workers/simulate

pub fn main() -> Nil {
  gleeunit.main()
}

/// An environment where `NAMES` is bound to the names Worker.
fn env() -> workers.Env {
  simulate.env()
  |> simulate.with_service("NAMES", simulate.context(), fn(request, ctx) {
    names.handle_request(request, simulate.env(), ctx)
  })
}

fn send(
  method: http.Method,
  path: String,
  env: workers.Env,
) -> Promise(Response) {
  greeter.handle_request(
    simulate.request(method, path),
    env,
    simulate.context(),
  )
}

pub fn greets_the_named_visitor_test() {
  use response <- promise.map(send(http.Get, "/", env()))
  assert response.status == 200
  assert simulate.read_body(response) == "Hello, Joe!"
}

pub fn uses_the_greeting_variable_test() {
  let env = env() |> simulate.env_var("GREETING", "Howdy")
  use response <- promise.map(send(http.Get, "/", env))
  assert simulate.read_body(response) == "Howdy, Joe!"
}

pub fn fails_without_the_names_binding_test() {
  use response <- promise.map(send(http.Get, "/", simulate.env()))
  assert response.status == 500
}

pub fn only_answers_get_test() {
  use response <- promise.map(send(http.Post, "/", env()))
  assert response.status == 405
}

pub fn unknown_path_test() {
  use response <- promise.map(send(http.Get, "/nope", env()))
  assert response.status == 404
}

pub fn names_worker_test() {
  use response <- promise.map(names.handle_request(
    simulate.request(http.Get, "/"),
    simulate.env(),
    simulate.context(),
  ))
  assert simulate.read_body(response) == "Joe"
}
