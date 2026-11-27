//// Unit tests for both Workers, run with `gleam test`. The environment comes
//// from the app, so the main Worker reaches the real names Worker the way it
//// does when deployed, without the Workers runtime or any binding name.

import gleam/http
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleeunit
import greeter
import greeter/front
import greeter/names
import rays/app
import rays/worker.{type Response}
import rays/worker/simulate

pub fn main() -> Nil {
  gleeunit.main()
}

/// Set up the app, so the main Worker reaches its other Workers, and give
/// the main Worker an env of its own for anything else, such as GREETING.
fn env() -> worker.Env {
  app.simulate(greeter.app(), context: simulate.context())
  simulate.env()
}

fn send(
  method: http.Method,
  path: String,
  env: worker.Env,
) -> Promise(Response) {
  front.handle_request(simulate.request(method, path), env, simulate.context())
}

pub fn app_is_valid_test() {
  assert app.validate(greeter.app()) == Ok(Nil)
}

pub fn greets_the_named_visitor_test() {
  use response <- promise.map(send(http.Get, "/", env()))
  assert response.status == 200
  assert simulate.read_body(response) == "Hello, Dr Joe!"
}

pub fn uses_the_greeting_variable_test() {
  let env = env() |> simulate.env_var("GREETING", "Howdy")
  use response <- promise.map(send(http.Get, "/", env))
  assert simulate.read_body(response) == "Howdy, Dr Joe!"
}

pub fn fails_without_the_names_worker_test() {
  // An app without the names Worker, so the main Worker has no binding to it.
  app.new("solo", main: front.worker)
  |> app.simulate(context: simulate.context())
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
  assert response.status == 404
}

pub fn catches_mistakes_in_the_app_test() {
  let assert Error(errors) =
    app.new("Bad Name", main: front.worker)
    |> app.register_worker(app.Worker("front", entrypoint: names.main))
    |> app.validate
  assert list.contains(errors, app.InvalidName("Bad Name"))
  assert list.contains(errors, app.DuplicateWorker("front"))
}
