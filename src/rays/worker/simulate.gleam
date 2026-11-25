//// Build requests, bindings, and contexts for unit testing Worker handlers
//// without the Workers runtime.
////
//// Handlers are ordinary functions, so a test calls one directly with a
//// simulated request and asserts on the Gleam `Response` it returns.
////
//// ```gleam
//// import gleam/http
//// import gleam/javascript/promise
//// import gleam/json
//// import rays/worker/simulate
////
//// pub fn create_person_test() {
////   let request =
////     simulate.request(http.Post, "/people")
////     |> simulate.json_body(json.object([#("name", json.string("Joe"))]))
////   let env = simulate.env() |> simulate.env_var("GREETING", "Hello")
////   let ctx = simulate.context()
////
////   use response <- promise.await(
////     app.handle_request(request, env, ctx),
////   )
////   use background <- promise.map(simulate.wait_for_background(ctx))
////   assert response.status == 201
////   assert background == Ok(Nil)
////   assert simulate.read_body(response) == "{\"name\":\"Joe\"}"
//// }
//// ```
////
//// Simulated contexts track background work registered with `wait_until`.
//// Await `wait_for_background` before asserting on its effects or finishing
//// a test. Calls to other Workers can be faked with `with_service`, but this
//// module does not otherwise emulate Cloudflare services: there are no fake
//// KV namespaces or D1 databases. To test against real bindings, use
//// Cloudflare's
//// [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
//// or [test harness](https://developers.cloudflare.com/workers/testing/test-harness/),
//// which run the compiled Worker in the Workers runtime.

import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/http.{type Method}
import gleam/http/request
import gleam/javascript/promise.{type Promise}
import gleam/json.{type Json}
import gleam/option.{None, Some}
import gleam/string
import gleam/uri
import rays/worker.{
  type Context, type Env, type JsRequest, type Request, type Response,
}

//
// Requests
//

/// Create a request with the given method and path, which may include a
/// query string. The request has no headers and an empty body, and is sent
/// to `https://example.com`.
///
/// # Examples
///
/// ```gleam
/// simulate.request(http.Get, "/users?page=2")
/// ```
///
pub fn request(method: Method, path: String) -> Request {
  let #(path, query) = case string.split_once(path, "?") {
    Ok(#(path, query)) -> #(path, Some(query))
    Error(_) -> #(path, None)
  }
  request.Request(
    method:,
    headers: [],
    body: worker.request_body(js_empty_request()),
    scheme: http.Https,
    host: "example.com",
    port: None,
    path:,
    query:,
  )
}

/// Set a header on the request, replacing any existing header with the same
/// name.
///
pub fn header(request: Request, name: String, value: String) -> Request {
  request.set_header(request, name, value)
}

/// Set the body of the request to the given text. The content type is not
/// changed.
///
pub fn string_body(request: Request, body: String) -> Request {
  request.set_body(request, worker.request_body(js_text_request(body)))
}

/// Set the body of the request to the given binary data. The content type is
/// not changed.
///
/// # Panics
///
/// Panics if the bit array is not a whole number of bytes.
///
pub fn bit_array_body(request: Request, body: BitArray) -> Request {
  assert worker.is_whole_bytes(body)
    as "simulate.bit_array_body requires a whole number of bytes"
  request.set_body(request, worker.request_body(js_bytes_request(body)))
}

/// Set the body of the request to the given HTML, and set the content type
/// to `text/html`.
///
pub fn html_body(request: Request, html: String) -> Request {
  request
  |> string_body(html)
  |> header("content-type", "text/html; charset=utf-8")
}

/// Set the body of the request to the given JSON, and set the content type
/// to `application/json`.
///
pub fn json_body(request: Request, data: Json) -> Request {
  request
  |> string_body(json.to_string(data))
  |> header("content-type", "application/json")
}

/// Set the body of the request to the given form values, URL-encoded, and
/// set the content type to `application/x-www-form-urlencoded`.
///
pub fn form_body(request: Request, data: List(#(String, String))) -> Request {
  request
  |> string_body(uri.query_to_string(data))
  |> header("content-type", "application/x-www-form-urlencoded")
}

@external(javascript, "./simulate_ffi.mts", "emptyRequest")
fn js_empty_request() -> JsRequest

@external(javascript, "./simulate_ffi.mts", "textRequest")
fn js_text_request(body: String) -> JsRequest

@external(javascript, "./simulate_ffi.mts", "bytesRequest")
fn js_bytes_request(body: BitArray) -> JsRequest

//
// Responses
//

/// Read the body of a response as a string.
///
/// # Panics
///
/// Panics in the same cases as `read_body_bits`, and if the body is not
/// valid UTF-8.
///
pub fn read_body(response: Response) -> String {
  let assert Ok(text) = bit_array.to_string(read_body_bits(response))
    as "simulate.read_body requires a UTF-8 body"
  text
}

/// Read the body of a response as a bit array.
///
/// # Panics
///
/// Panics if the body is a stream, which cannot be read synchronously, or is
/// binary data that is not a whole number of bytes, which `rays/worker`
/// would replace with a 500 response.
///
pub fn read_body_bits(response: Response) -> BitArray {
  case response.body {
    worker.Text(text) -> bit_array.from_string(text)
    worker.Bytes(bits) -> {
      assert worker.is_whole_bytes(bits)
        as "simulate.read_body_bits requires a whole number of bytes"
      bits
    }
    worker.Empty -> <<>>
    worker.Stream(_) ->
      panic as "simulate.read_body_bits cannot read a stream body"
  }
}

//
// Env & Context
//

/// Create an environment with no bindings.
///
@external(javascript, "./simulate_ffi.mts", "emptyEnv")
pub fn env() -> Env

/// Add a string environment variable or secret to the environment.
///
/// # Examples
///
/// ```gleam
/// simulate.env()
/// |> simulate.env_var("API_TOKEN", "secret")
/// ```
///
pub fn env_var(env: Env, name: String, value: String) -> Env {
  env_binding(env, name, dynamic.string(value))
}

/// Add any value to the environment as a binding, such as a test double you
/// have written for a KV namespace.
///
@external(javascript, "./simulate_ffi.mts", "envWith")
pub fn env_binding(env: Env, name: String, value: Dynamic) -> Env

/// Add a fake service binding to the environment. Requests sent to it with
/// `rays/fetch` are handled by the given function, as if by another Worker.
///
/// The request goes through the same conversion as a real request to a
/// Worker, so the handler receives an ordinary `Request`, together with the
/// given context. Background work the fake registers with `wait_until` is
/// waited for by `wait_for_background` on that context, mirroring how the
/// Workers runtime ties a bound Worker's background work to the caller's
/// request.
///
/// # Examples
///
/// ```gleam
/// let ctx = simulate.context()
/// let env =
///   simulate.env()
///   |> simulate.with_service("AUTH", ctx, fn(_request, _ctx) {
///     worker.ok() |> worker.string_body("joe") |> promise.resolve
///   })
/// ```
///
pub fn with_service(
  env: Env,
  name: String,
  context: Context,
  handler: fn(Request, Context) -> Promise(Response),
) -> Env {
  let worker =
    worker.new(fn(request: Request, _env: Env, ctx: Context) {
      handler(request, ctx)
    })
  js_env_with_service(env, name, worker, context)
}

@external(javascript, "./simulate_ffi.mts", "envWithService")
fn js_env_with_service(
  env: Env,
  name: String,
  worker: worker.Worker,
  context: Context,
) -> Env

/// Add a fake service binding to the environment, bound to the given
/// Worker, whose methods can be called with `rays/worker_rpc.call`.
///
/// Calls go straight to the handlers bound with `worker_rpc.bind`, with
/// `worker_env` as their bindings and the given context, without encoding
/// the values. So a simulated call doesn't check that its argument and reply
/// can be sent, or that the two Workers have the same version of the method:
/// test those with the Workers runtime, for example with Cloudflare's
/// [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/).
///
/// # Examples
///
/// ```gleam
/// let ctx = simulate.context()
/// let env =
///   simulate.env()
///   |> simulate.with_rpc_service("NAMES", ctx, names.main(), simulate.env())
/// ```
///
pub fn with_rpc_service(
  env: Env,
  name: String,
  context: Context,
  worker: worker.Worker,
  worker_env: Env,
) -> Env {
  js_env_with_rpc_service(env, name, worker, worker_env, context)
}

@external(javascript, "./simulate_ffi.mts", "envWithRpcService")
fn js_env_with_rpc_service(
  env: Env,
  name: String,
  worker: worker.Worker,
  worker_env: Env,
  context: Context,
) -> Env

/// Create an execution context that tracks work registered with `wait_until`.
/// Await `wait_for_background` before finishing a test to observe its completion
/// and failures. `pass_through_on_exception` does not forward requests.
///
@external(javascript, "./simulate_ffi.mts", "context")
pub fn context() -> Context

/// Wait for background work registered on a context created by `context`.
/// This includes work registered by other background tasks while waiting.
///
/// Resolves to `Error` with the first observed native rejection, after all
/// registered work has settled. A fulfilled `Error` is a value, not a
/// rejection. This does not cancel tasks or impose a timeout, and cannot
/// wait for work registered after all tracked tasks have finished.
///
@external(javascript, "./simulate_ffi.mts", "waitForBackground")
pub fn wait_for_background(ctx: Context) -> Promise(Result(Nil, Dynamic))
