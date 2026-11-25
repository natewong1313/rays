//// Tests for handler-facing behaviour: middleware, body reading, response
//// helpers, and env. These use `simulate` and assert on Gleam values
//// directly. The conversion to and from the Fetch API is tested in
//// `rays/worker/fetch_api_test`.

import gleam/dynamic
import gleam/dynamic/decode
import gleam/http
import gleam/http/response
import gleam/javascript/promise.{type Promise}
import gleam/json
import rays/worker.{type Request, type Response}
import rays/worker/simulate

fn echo_body(request: Request) -> Promise(Response) {
  use body <- worker.require_string_body(request)
  promise.resolve(worker.ok() |> worker.string_body(body))
}

fn post(path: String) -> Request {
  simulate.request(http.Post, path)
}

// Requests

pub fn path_and_query_test() {
  let request = simulate.request(http.Get, "/users/123?sort=name&page=2")
  assert worker.path_segments(request) == ["users", "123"]
  assert worker.get_query(request) == [#("sort", "name"), #("page", "2")]
  assert worker.get_query(simulate.request(http.Get, "/")) == []
}

pub fn malformed_query_is_empty_test() {
  assert worker.get_query(simulate.request(http.Get, "/?a=%zz")) == []
}

pub fn body_stream_test() {
  let request = post("/") |> simulate.string_body("hi")
  let assert Ok(_) = worker.body_stream(request)
  let assert Ok(_) = worker.body_stream(simulate.request(http.Get, "/"))
}

pub fn body_stream_after_read_test() {
  let request = post("/") |> simulate.string_body("hi")
  use _ <- promise.map(worker.read_body_string(request))
  assert worker.body_stream(request) == Error(worker.BodyAlreadyRead)
}

pub fn body_can_only_be_read_once_test() {
  let request = post("/") |> simulate.string_body("once")
  use first <- promise.await(worker.read_body_string(request))
  use second <- promise.map(worker.read_body_string(request))
  assert first == Ok("once")
  assert second == Error(worker.BodyAlreadyRead)
}

pub fn read_body_bits_test() {
  let request = post("/") |> simulate.bit_array_body(<<1, 2, 3>>)
  use bits <- promise.await(worker.read_body_bits(request))
  assert bits == Ok(<<1, 2, 3>>)
  use empty <- promise.map(
    worker.read_body_bits(simulate.request(http.Get, "/")),
  )
  assert empty == Ok(<<>>)
}

pub fn read_body_string_invalid_utf8_test() {
  let request = post("/") |> simulate.bit_array_body(<<0xff, 0xfe>>)
  use result <- promise.map(worker.read_body_string(request))
  assert result == Error(worker.InvalidUtf8)
}

// Middleware

pub fn require_method_test() {
  let handler = fn(request) {
    use <- worker.require_method(request, http.Post)
    promise.resolve(worker.ok())
  }
  use wrong <- promise.await(handler(simulate.request(http.Get, "/")))
  assert wrong.status == 405
  assert response.get_header(wrong, "allow") == Ok("POST")
  use right <- promise.map(handler(post("/")))
  assert right.status == 200
}

fn require_text_plain(request: Request) -> Promise(Response) {
  use <- worker.require_content_type(request, "Text/Plain")
  promise.resolve(worker.ok())
}

pub fn require_content_type_ignores_case_and_parameters_test() {
  let request =
    post("/") |> simulate.header("content-type", "text/PLAIN; charset=utf-8")
  use response <- promise.map(require_text_plain(request))
  assert response.status == 200
}

pub fn require_content_type_rejects_other_types_test() {
  let request = post("/") |> simulate.header("content-type", "text/html")
  use other <- promise.await(require_text_plain(request))
  assert other.status == 415
  assert response.get_header(other, "accept") == Ok("Text/Plain")
  use missing <- promise.map(require_text_plain(post("/")))
  assert missing.status == 415
}

pub fn require_string_body_test() {
  let request = post("/") |> simulate.string_body("Hello, Joe!")
  use response <- promise.map(echo_body(request))
  assert simulate.read_body(response) == "Hello, Joe!"
}

pub fn require_string_body_invalid_utf8_test() {
  let request = post("/") |> simulate.bit_array_body(<<0xff, 0xfe>>)
  use response <- promise.map(echo_body(request))
  assert response.status == 400
  assert simulate.read_body(response) == "Bad request: Invalid UTF-8"
}

pub fn require_string_body_already_read_test() {
  let request = post("/") |> simulate.string_body("once")
  use _ <- promise.await(worker.read_body_string(request))
  use response <- promise.map(echo_body(request))
  assert response.status == 500
}

pub fn require_bit_array_body_test() {
  let request = post("/") |> simulate.bit_array_body(<<1, 2>>)
  use response <- promise.map({
    use bits <- worker.require_bit_array_body(request)
    promise.resolve(worker.ok() |> worker.bit_array_body(bits))
  })
  assert simulate.read_body_bits(response) == <<1, 2>>
}

fn name_from_json(request: Request) -> Promise(Response) {
  use value <- worker.require_json(request)
  case decode.run(value, decode.at(["name"], decode.string)) {
    Ok(name) -> worker.ok() |> worker.string_body(name)
    Error(_) -> worker.unprocessable_content()
  }
  |> promise.resolve
}

pub fn require_json_test() {
  let request =
    post("/")
    |> simulate.json_body(json.object([#("name", json.string("Joe"))]))
  use response <- promise.map(name_from_json(request))
  assert simulate.read_body(response) == "Joe"
}

pub fn require_json_wrong_content_type_test() {
  let request = post("/") |> simulate.string_body("{}")
  use response <- promise.map(name_from_json(request))
  assert response.status == 415
  assert response.get_header(response, "accept") == Ok("application/json")
}

pub fn require_json_invalid_json_test() {
  let request =
    post("/")
    |> simulate.string_body("{nope")
    |> simulate.header("content-type", "application/json")
  use response <- promise.map(name_from_json(request))
  assert response.status == 400
  assert simulate.read_body(response) == "Bad request: Invalid JSON"
}

fn form_names(request: Request) -> Promise(Response) {
  use form <- worker.require_form(request)
  assert form == [#("age", "42"), #("name", "Joe")]
  promise.resolve(worker.ok())
}

pub fn require_form_test() {
  let request =
    post("/") |> simulate.form_body([#("name", "Joe"), #("age", "42")])
  use response <- promise.map(form_names(request))
  assert response.status == 200
}

pub fn require_form_wrong_content_type_test() {
  let request = post("/") |> simulate.string_body("name=Joe")
  use response <- promise.map(form_names(request))
  assert response.status == 415
}

pub fn require_form_invalid_encoding_test() {
  let request =
    post("/")
    |> simulate.string_body("name=%zz")
    |> simulate.header("content-type", "application/x-www-form-urlencoded")
  use response <- promise.map(form_names(request))
  assert response.status == 400
  assert simulate.read_body(response) == "Bad request: Invalid form encoding"
}

// Responses

pub fn body_helpers_set_content_type_test() {
  let html = worker.html_response("<p>", 200)
  assert response.get_header(html, "content-type")
    == Ok("text/html; charset=utf-8")
  let json = worker.json_response(json.object([]), 201)
  assert json.status == 201
  assert simulate.read_body(json) == "{}"
  assert response.get_header(json, "content-type")
    == Ok("application/json; charset=utf-8")
}

pub fn method_not_allowed_test() {
  let response = worker.method_not_allowed([http.Post, http.Get])
  assert response.status == 405
  assert response.get_header(response, "allow") == Ok("GET, POST")
}

pub fn unsupported_media_type_test() {
  let response =
    worker.unsupported_media_type(accept: ["text/html", "application/json"])
  assert response.status == 415
  assert response.get_header(response, "accept")
    == Ok("text/html, application/json")
}

pub fn redirect_test() {
  let response = worker.redirect(to: "/home")
  assert response.status == 303
  assert response.get_header(response, "location") == Ok("/home")
  let permanent = worker.permanent_redirect(to: "/new")
  assert permanent.status == 308
  assert response.get_header(permanent, "location") == Ok("/new")
}

pub fn status_responses_test() {
  assert worker.content_too_large().status == 413
  assert worker.unprocessable_content().status == 422
  assert worker.internal_server_error().status == 500
  assert worker.no_content().body == worker.Empty
}

pub fn bad_request_detail_test() {
  assert simulate.read_body(worker.bad_request("")) == "Bad request"
  assert simulate.read_body(worker.bad_request("Nope")) == "Bad request: Nope"
}

// Env

pub fn env_test() {
  let env =
    simulate.env()
    |> simulate.env_var("GREETING", "Hello")
    |> simulate.env_binding("KV", dynamic.int(1))
    |> simulate.env_binding("NULL", dynamic.nil())
  assert worker.env_var(env, "GREETING") == Ok("Hello")
  assert worker.env_var(env, "MISSING") == Error(Nil)
  // Bindings that are not strings are not environment variables.
  assert worker.env_var(env, "KV") == Error(Nil)
  assert worker.env_binding(env, "KV") == Ok(dynamic.int(1))
  assert worker.env_binding(env, "MISSING") == Error(Nil)
  assert worker.env_binding(env, "NULL") == Error(Nil)
}
