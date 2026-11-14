//// Tests for handler-facing behaviour: middleware, body reading, response
//// helpers, and env. These use `simulate` and assert on Gleam values
//// directly. The conversion to and from the Fetch API is tested in
//// `workers_fetch_test`.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/http
import gleam/http/response
import gleam/javascript/promise.{type Promise}
import gleam/json
import rays/workers.{type Request, type Response}
import rays/workers/simulate

fn echo_body(request: Request) -> Promise(Response) {
  use body <- workers.require_string_body(request)
  promise.resolve(workers.ok() |> workers.string_body(body))
}

pub fn path_and_query_test() {
  let request = simulate.request(http.Get, "/users/123?sort=name&page=2")
  assert workers.path_segments(request) == ["users", "123"]
  assert workers.get_query(request) == [#("sort", "name"), #("page", "2")]
  assert workers.get_query(simulate.request(http.Get, "/")) == []
}

pub fn body_stream_test() {
  let request = simulate.request(http.Post, "/") |> simulate.string_body("hi")
  let assert Ok(_) = workers.body_stream(request)
  assert workers.body_stream(simulate.request(http.Get, "/")) == Error(Nil)
}

pub fn body_can_only_be_read_once_test() {
  let request = simulate.request(http.Post, "/") |> simulate.string_body("once")
  use first <- promise.await(workers.read_body_string(request))
  use second <- promise.map(workers.read_body_string(request))
  assert first == Ok("once")
  assert second == Error(workers.BodyAlreadyRead)
}

pub fn require_method_test() {
  let handler = fn(request) {
    use <- workers.require_method(request, http.Post)
    promise.resolve(workers.ok())
  }
  use wrong <- promise.await(handler(simulate.request(http.Get, "/")))
  assert wrong.status == 405
  assert response.get_header(wrong, "allow") == Ok("POST")
  use right <- promise.map(handler(simulate.request(http.Post, "/")))
  assert right.status == 200
}

pub fn require_content_type_ignores_parameters_test() {
  let request =
    simulate.request(http.Post, "/")
    |> simulate.header("content-type", "Text/Plain; charset=utf-8")
  use response <- promise.map({
    use <- workers.require_content_type(request, "text/plain")
    promise.resolve(workers.ok())
  })
  assert response.status == 200
}

pub fn require_string_body_test() {
  let request =
    simulate.request(http.Post, "/") |> simulate.string_body("Hello, Joe!")
  use response <- promise.map(echo_body(request))
  assert simulate.read_body(response) == "Hello, Joe!"
}

pub fn require_string_body_invalid_utf8_test() {
  let request =
    simulate.request(http.Post, "/") |> simulate.bit_array_body(<<0xff, 0xfe>>)
  use response <- promise.map(echo_body(request))
  assert response.status == 400
  assert simulate.read_body(response) == "Bad request: Invalid UTF-8"
}

fn name_from_json(request: Request) -> Promise(Response) {
  use json <- workers.require_json(request)
  case decode.run(json, decode.at(["name"], decode.string)) {
    Ok(name) -> workers.ok() |> workers.string_body(name)
    Error(_) -> workers.unprocessable_content()
  }
  |> promise.resolve
}

pub fn require_json_test() {
  let request =
    simulate.request(http.Post, "/")
    |> simulate.json_body(json.object([#("name", json.string("Joe"))]))
  use response <- promise.map(name_from_json(request))
  assert simulate.read_body(response) == "Joe"
}

pub fn require_json_wrong_content_type_test() {
  let request = simulate.request(http.Post, "/") |> simulate.string_body("{}")
  use response <- promise.map(name_from_json(request))
  assert response.status == 415
  assert response.get_header(response, "accept") == Ok("application/json")
}

pub fn require_json_invalid_json_test() {
  let request =
    simulate.request(http.Post, "/")
    |> simulate.string_body("{nope")
    |> simulate.header("content-type", "application/json")
  use response <- promise.map(name_from_json(request))
  assert response.status == 400
}

pub fn require_form_test() {
  let request =
    simulate.request(http.Post, "/")
    |> simulate.form_body([#("name", "Joe"), #("age", "42")])
  use response <- promise.map({
    use form <- workers.require_form(request)
    assert form == [#("age", "42"), #("name", "Joe")]
    promise.resolve(workers.ok())
  })
  assert response.status == 200
}

pub fn body_helpers_set_content_type_test() {
  let html = workers.html_response("<p>", 200)
  assert response.get_header(html, "content-type")
    == Ok("text/html; charset=utf-8")
  let json = workers.json_response("{}", 201)
  assert json.status == 201
  assert response.get_header(json, "content-type")
    == Ok("application/json; charset=utf-8")
}

pub fn method_not_allowed_test() {
  let response = workers.method_not_allowed([http.Post, http.Get])
  assert response.status == 405
  assert response.get_header(response, "allow") == Ok("GET, POST")
}

pub fn redirect_test() {
  let response = workers.redirect(to: "/home")
  assert response.status == 303
  assert response.get_header(response, "location") == Ok("/home")
}

pub fn bad_request_detail_test() {
  assert simulate.read_body(workers.bad_request("")) == "Bad request"
  assert simulate.read_body(workers.bad_request("Nope")) == "Bad request: Nope"
}

pub fn env_test() {
  let env =
    simulate.env()
    |> simulate.env_var("GREETING", "Hello")
    |> simulate.env_binding("KV", dynamic.int(1))
  assert workers.env_var(env, "GREETING") == Ok("Hello")
  assert workers.env_var(env, "MISSING") == Error(Nil)
  // Bindings that are not strings are not environment variables.
  assert workers.env_var(env, "KV") == Error(Nil)
  assert workers.env_binding(env, "KV") == Ok(dynamic.int(1))
  assert workers.env_binding(env, "MISSING") == Error(Nil)
}
