//// Tests for the boundary between the Workers runtime and Gleam: converting
//// a Fetch API `Request` into a Gleam request, and a Gleam response back into
//// a Fetch API `Response`. Handler logic is tested with `simulate` instead,
//// in `workers_test`.

import gleam/http
import gleam/http/response
import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}
import gleam/option.{None, Some}
import rays/workers.{type Context, type Env, type Request, type Response}

type JsRequest

type JsResponse

@external(javascript, "./workers_fetch_test_ffi.mts", "request")
fn js_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
  body: String,
) -> JsRequest

@external(javascript, "./workers_fetch_test_ffi.mts", "run")
fn js_run(
  worker: workers.Worker,
  request: JsRequest,
) -> Promise(#(JsResponse, Int, Bool))

@external(javascript, "./workers_fetch_test_ffi.mts", "status")
fn status(response: JsResponse) -> Int

@external(javascript, "./workers_fetch_test_ffi.mts", "header")
fn header(response: JsResponse, name: String) -> Result(String, Nil)

@external(javascript, "./workers_fetch_test_ffi.mts", "setCookies")
fn set_cookies(response: JsResponse) -> Array(String)

@external(javascript, "./workers_fetch_test_ffi.mts", "hasBody")
fn has_body(response: JsResponse) -> Bool

@external(javascript, "./workers_fetch_test_ffi.mts", "text")
fn text(response: JsResponse) -> Promise(String)

/// Send a GET request for `/` to a Worker that always returns `response`.
fn respond_with(response: Response) -> Promise(JsResponse) {
  let request =
    js_request("GET", "https://example.com/", array.from_list([]), "")
  send(fn(_, _, _) { promise.resolve(response) }, request)
}

fn send(
  handler: fn(Request, Env, Context) -> Promise(Response),
  request: JsRequest,
) -> Promise(JsResponse) {
  use #(response, _, _) <- promise.map(js_run(workers.new(handler), request))
  response
}

pub fn request_fields_are_converted_test() {
  let request =
    js_request(
      "PURGE",
      "http://localhost:8787/users/123?sort=name",
      array.from_list([#("X-Custom", "Hello")]),
      "",
    )
  let handler = fn(req: Request, _, _) {
    assert req.method == http.Other("PURGE")
    assert req.scheme == http.Http
    assert req.host == "localhost"
    assert req.port == Some(8787)
    assert req.path == "/users/123"
    assert req.query == Some("sort=name")
    // Header names are lowercased by the Fetch API.
    assert req.headers == [#("x-custom", "Hello")]
    assert workers.cf_properties(req) == Error(Nil)
    promise.resolve(workers.ok())
  }
  use response <- promise.map(send(handler, request))
  assert status(response) == 200
}

pub fn default_port_is_none_test() {
  let request =
    js_request("GET", "https://example.com:443/", array.from_list([]), "")
  let handler = fn(req: Request, _, _) {
    assert req.method == http.Get
    assert req.port == None
    promise.resolve(workers.ok())
  }
  use response <- promise.map(send(handler, request))
  assert status(response) == 200
}

pub fn request_body_is_readable_test() {
  let request =
    js_request("POST", "https://example.com/", array.from_list([]), "Hi!")
  let handler = fn(req: Request, _, _) {
    use body <- workers.require_string_body(req)
    promise.resolve(workers.ok() |> workers.string_body(body))
  }
  use response <- promise.await(send(handler, request))
  use body <- promise.map(text(response))
  assert body == "Hi!"
}

pub fn text_response_test() {
  use response <- promise.await(respond_with(
    workers.response(201)
    |> workers.set_header("x-thing", "1")
    |> workers.string_body("Hello, Joe!"),
  ))
  assert status(response) == 201
  assert header(response, "x-thing") == Ok("1")
  use body <- promise.map(text(response))
  assert body == "Hello, Joe!"
}

pub fn bytes_response_test() {
  use response <- promise.await(respond_with(
    workers.ok() |> workers.bit_array_body(<<"bytes":utf8>>),
  ))
  use body <- promise.map(text(response))
  assert body == "bytes"
}

pub fn unaligned_bit_array_is_server_error_test() {
  use response <- promise.map(respond_with(
    workers.ok() |> workers.bit_array_body(<<1:size(3)>>),
  ))
  assert status(response) == 500
}

pub fn stream_body_passes_through_test() {
  let request =
    js_request("POST", "https://example.com/", array.from_list([]), "streamed!")
  let handler = fn(req: Request, _, _) {
    let assert Ok(stream) = workers.body_stream(req)
    promise.resolve(workers.ok() |> workers.stream_body(stream))
  }
  use response <- promise.await(send(handler, request))
  use body <- promise.map(text(response))
  assert body == "streamed!"
}

pub fn repeated_headers_are_preserved_test() {
  let headers = [#("set-cookie", "a=1"), #("set-cookie", "b=2")]
  use response <- promise.map(respond_with(
    response.Response(..workers.no_content(), headers:),
  ))
  assert array.to_list(set_cookies(response)) == ["a=1", "b=2"]
}

pub fn null_body_statuses_do_not_throw_test() {
  // The Fetch API throws if a 204 is given any body, even an empty string.
  use response <- promise.map(respond_with(
    workers.response(204) |> workers.string_body(""),
  ))
  assert status(response) == 204
  assert !has_body(response)
}

pub fn context_is_passed_through_test() {
  let request =
    js_request("GET", "https://example.com/", array.from_list([]), "")
  let handler = fn(_, _, ctx: Context) {
    workers.wait_until(ctx, promise.wait(1))
    workers.pass_through_on_exception(ctx)
    promise.resolve(workers.ok())
  }
  use #(_, waited, passed_through) <- promise.map(js_run(
    workers.new(handler),
    request,
  ))
  assert waited == 1
  assert passed_through
}
