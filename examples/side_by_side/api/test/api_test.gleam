//// Unit tests for the Gleam Worker. The TypeScript Worker is replaced by a
//// fake service binding, so these run with `gleam test` alone. The real
//// wiring between the two Workers is tested in `test/side_by_side.spec.ts`.

import api
import gleam/http
import gleam/javascript/promise.{type Promise}
import gleeunit
import rays/worker.{type Response}
import rays/worker/simulate

pub fn main() -> Nil {
  gleeunit.main()
}

/// An environment where the `WEB` binding answers `/whoami` with a name.
fn env_with_web(name: String) -> worker.Env {
  simulate.env()
  |> simulate.with_service("WEB", simulate.context(), fn(request, _) {
    case worker.path_segments(request) {
      ["whoami"] -> worker.ok() |> worker.string_body(name)
      _ -> worker.not_found()
    }
    |> promise.resolve
  })
}

fn get(path: String, env: worker.Env) -> Promise(Response) {
  api.handle_request(simulate.request(http.Get, path), env, simulate.context())
}

pub fn greeting_test() {
  use response <- promise.map(get("/api/greeting", env_with_web("Lucy")))
  assert response.status == 200
  assert simulate.read_body(response) == "Hello, Lucy, from Gleam!"
}

pub fn whoami_forwards_the_web_response_test() {
  use response <- promise.map(get("/api/whoami", env_with_web("Lucy")))
  assert response.status == 200
  let assert worker.Stream(_) = response.body
}

pub fn missing_web_binding_test() {
  use response <- promise.map(get("/api/greeting", simulate.env()))
  assert response.status == 500
}

pub fn unknown_path_test() {
  use response <- promise.map(get("/api/nope", env_with_web("Lucy")))
  assert response.status == 404
}
