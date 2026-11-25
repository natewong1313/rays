//// Tests for the boundary between the Workers runtime and Gleam: converting
//// a Fetch API `Request` into a Gleam request, and a Gleam response back into
//// a Fetch API `Response`. Handler logic is tested with `simulate` instead,
//// in `worker_test`.

import gleam/http
import gleam/http/response
import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}
import gleam/option.{None, Some}
import rays/worker.{type Context, type Handler, type Request, type Response}

type JsRequest

type JsResponse

@external(javascript, "./fetch_api_test_ffi.mts", "request")
fn js_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
) -> JsRequest

@external(javascript, "./fetch_api_test_ffi.mts", "requestWithBody")
fn js_request_with_body(
  method: String,
  url: String,
  headers: Array(#(String, String)),
  body: String,
) -> JsRequest

@external(javascript, "./fetch_api_test_ffi.mts", "failingBodyRequest")
fn js_failing_body_request(url: String) -> JsRequest

@external(javascript, "./fetch_api_test_ffi.mts", "run")
fn js_run(
  worker: worker.Worker,
  request: JsRequest,
) -> Promise(#(JsResponse, Int, Bool))

@external(javascript, "./fetch_api_test_ffi.mts", "status")
fn status(response: JsResponse) -> Int

@external(javascript, "./fetch_api_test_ffi.mts", "header")
fn header(response: JsResponse, name: String) -> Result(String, Nil)

@external(javascript, "./fetch_api_test_ffi.mts", "setCookies")
fn set_cookies(response: JsResponse) -> Array(String)

@external(javascript, "./fetch_api_test_ffi.mts", "hasBody")
fn has_body(response: JsResponse) -> Bool

@external(javascript, "./fetch_api_test_ffi.mts", "text")
fn text(response: JsResponse) -> Promise(String)

/// What the runtime observed after a Worker handled a request.
type Outcome {
  Outcome(response: JsResponse, waited: Int, passed_through: Bool)
}

fn run(handler: Handler, request: JsRequest) -> Promise(Outcome) {
  use #(response, waited, passed_through) <- promise.map(js_run(
    worker.new(handler),
    request,
  ))
  Outcome(response:, waited:, passed_through:)
}

fn send(handler: Handler, request: JsRequest) -> Promise(JsResponse) {
  use outcome <- promise.map(run(handler, request))
  outcome.response
}

fn get_root() -> JsRequest {
  js_request("GET", "https://example.com/", array.from_list([]))
}

fn post_root(body: String) -> JsRequest {
  js_request_with_body(
    "POST",
    "https://example.com/",
    array.from_list([]),
    body,
  )
}

/// Send a GET request for `/` to a Worker that always returns `response`.
fn respond_with(response: Response) -> Promise(JsResponse) {
  send(fn(_, _, _) { promise.resolve(response) }, get_root())
}

fn echo_body(req: Request, _, _) -> Promise(Response) {
  use body <- worker.require_string_body(req)
  promise.resolve(worker.ok() |> worker.string_body(body))
}

// Requests

pub fn request_fields_are_converted_test() {
  let request =
    js_request(
      "PURGE",
      "http://localhost:8787/users/123?sort=name",
      array.from_list([#("X-Custom", "Hello")]),
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
    assert worker.cf_properties(req) == Error(Nil)
    promise.resolve(worker.ok())
  }
  use response <- promise.map(send(handler, request))
  assert status(response) == 200
}

pub fn default_port_is_none_test() {
  let request =
    js_request("GET", "https://example.com:443/", array.from_list([]))
  let handler = fn(req: Request, _, _) {
    assert req.method == http.Get
    assert req.port == None
    promise.resolve(worker.ok())
  }
  use response <- promise.map(send(handler, request))
  assert status(response) == 200
}

pub fn unsupported_scheme_is_bad_request_test() {
  let request = js_request("GET", "ftp://example.com/", array.from_list([]))
  let handler = fn(_, _, _) { panic as "the handler should not be called" }
  use response <- promise.await(send(handler, request))
  assert status(response) == 400
  use body <- promise.map(text(response))
  assert body == "Bad request: Unsupported URL scheme"
}

pub fn request_body_is_readable_test() {
  use response <- promise.await(send(echo_body, post_root("Hi!")))
  use body <- promise.map(text(response))
  assert body == "Hi!"
}

pub fn failed_body_read_is_bad_request_test() {
  let handler = fn(req: Request, _, _) {
    use result <- promise.map(worker.read_body_bits(req))
    assert result == Error(worker.BodyReadFailed(reason: "connection lost"))
    worker.ok()
  }
  use response <- promise.await(send(
    handler,
    js_failing_body_request("https://example.com/"),
  ))
  assert status(response) == 200
  use response <- promise.map(send(
    echo_body,
    js_failing_body_request("https://example.com/"),
  ))
  assert status(response) == 400
}

// Responses

pub fn text_response_test() {
  use response <- promise.await(respond_with(
    worker.response(201)
    |> worker.set_header("x-thing", "1")
    |> worker.string_body("Hello, Joe!"),
  ))
  assert status(response) == 201
  assert header(response, "x-thing") == Ok("1")
  use body <- promise.map(text(response))
  assert body == "Hello, Joe!"
}

pub fn bytes_response_test() {
  use response <- promise.await(respond_with(
    worker.ok() |> worker.bit_array_body(<<"bytes":utf8>>),
  ))
  use body <- promise.map(text(response))
  assert body == "bytes"
}

pub fn unaligned_bit_array_is_server_error_test() {
  use response <- promise.await(respond_with(
    worker.ok() |> worker.bit_array_body(<<1:size(3)>>),
  ))
  assert status(response) == 500
  assert header(response, "content-type") == Ok("text/plain; charset=utf-8")
  use body <- promise.map(text(response))
  assert body == "Internal server error"
}

pub fn stream_body_passes_through_test() {
  let handler = fn(req: Request, _, _) {
    let assert Ok(stream) = worker.body_stream(req)
    promise.resolve(worker.ok() |> worker.stream_body(stream))
  }
  use response <- promise.await(send(handler, post_root("streamed!")))
  use body <- promise.map(text(response))
  assert body == "streamed!"
}

pub fn repeated_headers_are_preserved_test() {
  let headers = [#("set-cookie", "a=1"), #("set-cookie", "b=2")]
  use response <- promise.map(respond_with(
    response.Response(..worker.no_content(), headers:),
  ))
  assert array.to_list(set_cookies(response)) == ["a=1", "b=2"]
}

pub fn null_body_statuses_drop_the_body_test() {
  // The Fetch API throws if a 204 is given any body, even an empty string.
  use response <- promise.await(respond_with(
    worker.response(204) |> worker.string_body(""),
  ))
  assert status(response) == 204
  assert !has_body(response)
  use response <- promise.map(respond_with(
    worker.response(304) |> worker.string_body("cached"),
  ))
  assert status(response) == 304
  assert !has_body(response)
}

// Context

pub fn context_is_passed_through_test() {
  let handler = fn(_, _, ctx: Context) {
    worker.wait_until(ctx, promise.wait(1))
    worker.pass_through_on_exception(ctx)
    promise.resolve(worker.ok())
  }
  use outcome <- promise.map(run(handler, get_root()))
  assert outcome.waited == 1
  assert outcome.passed_through
}
