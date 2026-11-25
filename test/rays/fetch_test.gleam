//// Tests for `rays/fetch`: building and sending requests, classifying send
//// failures, and reading or forwarding the responses that come back.
////
//// Requests to other Workers go to fake service bindings from `simulate`,
//// which pass them through the real Fetch API conversion. Requests to the
//// internet go to a stand-in for the global `fetch`.

import gleam/dynamic
import gleam/http
import gleam/http/request.{type Request}
import gleam/http/response
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/option.{Some}
import gleam/string
import rays/fetch
import rays/worker.{type Body, type ReadableStream}
import rays/worker/simulate

@external(javascript, "./fetch_test_ffi.mts", "streamOf")
fn stream_of(text: String) -> ReadableStream

@external(javascript, "./fetch_test_ffi.mts", "streamText")
fn stream_text(stream: ReadableStream) -> Promise(String)

@external(javascript, "./fetch_test_ffi.mts", "withStubbedFetch")
fn with_stubbed_fetch(behaviour: String, run: fn() -> Promise(a)) -> Promise(a)

/// A Worker that describes the request it received: its method and path in
/// headers, and its body as the response body.
fn describe(request: worker.Request) -> Promise(worker.Response) {
  use body <- worker.require_string_body(request)
  let query = case request.query {
    Some(query) -> "?" <> query
    _ -> ""
  }
  worker.ok()
  |> worker.string_body(body)
  |> worker.set_header("x-method", http.method_to_string(request.method))
  |> worker.set_header("x-path", request.path <> query)
  |> response.prepend_header("set-cookie", "a=1")
  |> response.prepend_header("set-cookie", "b=2")
  |> promise.resolve
}

fn echo_service() -> fetch.Target {
  let assert Ok(target) =
    simulate.env()
    |> simulate.with_service("ECHO", simulate.context(), fn(request, _) {
      describe(request)
    })
    |> fetch.service("ECHO")
  target
}

fn new_request(body: Body) -> Request(Body) {
  request.new() |> request.set_body(body)
}

// Targets

pub fn service_lookup_test() {
  let env =
    simulate.env()
    |> simulate.env_var("NAME", "not a service")
    |> simulate.env_binding("OBJECT", dynamic.properties([]))
    |> simulate.with_service("ECHO", simulate.context(), fn(request, _) {
      describe(request)
    })
  let assert Ok(_) = fetch.service(env, "ECHO")
  assert fetch.service(env, "MISSING") == Error(Nil)
  assert fetch.service(env, "NAME") == Error(Nil)
  assert fetch.service(env, "OBJECT") == Error(Nil)
}

// Sending to a service

pub fn send_text_test() {
  let request =
    new_request(worker.Text("hello"))
    |> request.set_method(http.Post)
    |> request.set_path("/greet")
    |> request.set_query([#("name", "Joe")])
  use result <- promise.await(fetch.send(request, to: echo_service()))
  let assert Ok(response) = result
  assert response.status == 200
  assert response.get_header(response, "x-method") == Ok("POST")
  assert response.get_header(response, "x-path") == Ok("/greet?name=Joe")
  use text <- promise.map(fetch.read_text(response))
  assert text == Ok("hello")
}

pub fn send_empty_test() {
  let request = new_request(worker.Empty) |> request.set_path("/nothing")
  use result <- promise.await(fetch.send(request, to: echo_service()))
  let assert Ok(response) = result
  assert response.get_header(response, "x-method") == Ok("GET")
  use text <- promise.map(fetch.read_text(response))
  assert text == Ok("")
}

pub fn send_bytes_test() {
  let request =
    new_request(worker.Bytes(<<"bytes":utf8>>))
    |> request.set_method(http.Put)
  use result <- promise.await(fetch.send(request, to: echo_service()))
  let assert Ok(response) = result
  use bits <- promise.map(fetch.read_bits(response))
  assert bits == Ok(<<"bytes":utf8>>)
}

pub fn send_stream_test() {
  let request =
    new_request(worker.Stream(stream_of("streamed")))
    |> request.set_method(http.Post)
  use result <- promise.await(fetch.send(request, to: echo_service()))
  let assert Ok(response) = result
  use text <- promise.map(fetch.read_text(response))
  assert text == Ok("streamed")
}

pub fn send_headers_test() {
  let request =
    new_request(worker.Empty)
    |> request.set_header("x-greeting", "hi")
  let service = fn(request: worker.Request, _ctx: worker.Context) {
    let greeting = request.get_header(request, "x-greeting")
    let assert Ok(greeting) = greeting
    worker.ok() |> worker.string_body(greeting) |> promise.resolve
  }
  let assert Ok(target) =
    simulate.env()
    |> simulate.with_service("SERVICE", simulate.context(), service)
    |> fetch.service("SERVICE")
  use result <- promise.await(fetch.send(request, to: target))
  let assert Ok(response) = result
  use text <- promise.map(fetch.read_text(response))
  assert text == Ok("hi")
}

pub fn repeated_response_headers_test() {
  use result <- promise.map(fetch.send(
    new_request(worker.Empty),
    to: echo_service(),
  ))
  let assert Ok(response) = result
  assert list.key_filter(response.headers, "set-cookie") == ["b=2", "a=1"]
}

pub fn error_status_is_ok_test() {
  let assert Ok(target) =
    simulate.env()
    |> simulate.with_service("MISSING", simulate.context(), fn(_request, _) {
      promise.resolve(worker.not_found())
    })
    |> fetch.service("MISSING")
  use result <- promise.map(fetch.send(new_request(worker.Empty), to: target))
  let assert Ok(response) = result
  assert response.status == 404
}

pub fn service_background_failure_is_surfaced_test() {
  let ctx = simulate.context()
  let assert Ok(target) =
    simulate.env()
    |> simulate.with_service("BG", ctx, fn(_request, service_ctx) {
      worker.wait_until(
        service_ctx,
        promise.resolve(Nil) |> promise.map(fn(_) { panic as "failed" }),
      )
      promise.resolve(worker.ok())
    })
    |> fetch.service("BG")
  use result <- promise.await(fetch.send(new_request(worker.Empty), to: target))
  let assert Ok(response) = result
  assert response.status == 200
  use background <- promise.map(simulate.wait_for_background(ctx))
  let assert Error(_) = background
  Nil
}

// Invalid requests

pub fn get_with_body_is_invalid_test() {
  use result <- promise.map(fetch.send(
    new_request(worker.Text("not allowed")),
    to: echo_service(),
  ))
  let assert Error(fetch.InvalidRequest(_)) = result
}

pub fn partial_bytes_are_invalid_test() {
  let request =
    new_request(worker.Bytes(<<1:size(3)>>))
    |> request.set_method(http.Post)
  use result <- promise.map(fetch.send(request, to: echo_service()))
  assert result
    == Error(fetch.InvalidRequest("Request body is not a whole number of bytes"))
}

// Reading and forwarding responses

pub fn body_can_only_be_read_once_test() {
  use result <- promise.await(fetch.send(
    new_request(worker.Empty),
    to: echo_service(),
  ))
  let assert Ok(response) = result
  use first <- promise.await(fetch.read_text(response))
  use second <- promise.map(fetch.read_text(response))
  assert first == Ok("")
  assert second == Error(worker.BodyAlreadyRead)
  assert fetch.forward(response) == Error(worker.BodyAlreadyRead)
}

pub fn invalid_utf8_test() {
  let assert Ok(target) =
    simulate.env()
    |> simulate.with_service("BYTES", simulate.context(), fn(_request, _) {
      worker.ok() |> worker.bit_array_body(<<255>>) |> promise.resolve
    })
    |> fetch.service("BYTES")
  use result <- promise.map(fetch.send(new_request(worker.Empty), to: target))
  let assert Ok(response) = result
  use text <- promise.map(fetch.read_text(response))
  assert text == Error(worker.InvalidUtf8)
}

pub fn forward_streams_body_test() {
  let request =
    new_request(worker.Text("pass it on"))
    |> request.set_method(http.Post)
  use result <- promise.await(fetch.send(request, to: echo_service()))
  let assert Ok(received) = result
  let assert Ok(forwarded) = fetch.forward(received)
  assert forwarded.status == 200
  assert response.get_header(forwarded, "x-method") == Ok("POST")
  let assert worker.Stream(stream) = forwarded.body
  use text <- promise.map(stream_text(stream))
  assert text == "pass it on"
}

pub fn forward_without_body_test() {
  let assert Ok(target) =
    simulate.env()
    |> simulate.with_service("EMPTY", simulate.context(), fn(_request, _) {
      promise.resolve(worker.no_content())
    })
    |> fetch.service("EMPTY")
  use result <- promise.map(fetch.send(new_request(worker.Empty), to: target))
  let assert Ok(received) = result
  let assert Ok(forwarded) = fetch.forward(received)
  assert forwarded.status == 204
  assert forwarded.body == worker.Empty
}

// Sending to the internet

pub fn global_uses_request_url_test() {
  use <- with_stubbed_fetch("echo_url")
  let request =
    new_request(worker.Empty)
    |> request.set_scheme(http.Http)
    |> request.set_host("example.com")
    |> request.set_port(8080)
    |> request.set_path("/search")
    |> request.set_query([#("q", "gleam")])
  use result <- promise.await(fetch.send(request, to: fetch.global()))
  let assert Ok(response) = result
  use text <- promise.map(fetch.read_text(response))
  assert text == Ok("GET http://example.com:8080/search?q=gleam")
}

pub fn network_error_test() {
  use <- with_stubbed_fetch("type_error")
  use result <- promise.map(fetch.send(
    new_request(worker.Empty),
    to: fetch.global(),
  ))
  assert result == Error(fetch.NetworkError("fetch failed"))
}

pub fn synchronous_throw_test() {
  use <- with_stubbed_fetch("sync_throw")
  use result <- promise.map(fetch.send(
    new_request(worker.Empty),
    to: fetch.global(),
  ))
  assert result == Error(fetch.NetworkError("thrown synchronously"))
}

pub fn unknown_error_test() {
  use <- with_stubbed_fetch("other_error")
  use result <- promise.map(fetch.send(
    new_request(worker.Empty),
    to: fetch.global(),
  ))
  let assert Error(fetch.Unknown(message)) = result
  assert string.contains(message, "something else")
}
