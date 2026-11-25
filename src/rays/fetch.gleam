//// Send HTTP requests from a Worker, to another Worker through a
//// [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
//// or to the internet with the global `fetch`.
////
//// Requests are `gleam_http` requests with a `worker.Body`, the same body
//// type used to build responses. Responses come back with a `ResponseBody`
//// that is not read until you ask for it, so a response from another Worker
//// can be passed on to the client without buffering it, using `forward`.
////
//// ```gleam
//// import gleam/http/request
//// import gleam/javascript/promise.{type Promise}
//// import gleam/result
//// import rays/fetch
//// import rays/worker.{type Env, type Response}
////
//// // Ask the Worker bound as `AUTH` who the user is, and pass its answer on.
//// fn whoami(env: Env) -> Promise(Response) {
////   case fetch.service(env, "AUTH") {
////     Error(_) -> promise.resolve(worker.internal_server_error())
////     Ok(auth) -> {
////       let request =
////         request.new()
////         |> request.set_path("/whoami")
////         |> request.set_body(worker.Empty)
////       use result <- promise.map(fetch.send(request, to: auth))
////       case result {
////         Ok(response) ->
////           fetch.forward(response)
////           |> result.unwrap(worker.internal_server_error())
////         Error(_) -> worker.response(502)
////       }
////     }
////   }
//// }
//// ```
////
//// A service binding ignores the request's host, so the default `localhost`
//// from `request.new` is fine. A request sent with `global` goes to the
//// request's scheme, host, and port.

import gleam/http
import gleam/http/request.{type Request}
import gleam/http/response.{type Response, Response}
import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}
import gleam/result
import gleam/uri
import rays/worker.{type Body, type BodyError, type Env, type ReadableStream}

//
// Targets
//

/// Where a request is sent: the global `fetch`, or another Worker through a
/// service binding.
///
pub opaque type Target {
  Target(fetcher: Fetcher)
}

/// The JavaScript object that sends a request: `{ fetch }` for the global
/// `fetch`, or a service binding.
type Fetcher

/// Send requests to the internet, with the Workers runtime's global `fetch`.
///
pub fn global() -> Target {
  Target(js_global_fetcher())
}

/// Send requests to the Worker bound to the given name, through a service
/// binding.
///
/// Returns an error if there is no binding with that name, or if the binding
/// is not a service binding, for example because it is a KV namespace.
///
/// # Examples
///
/// ```gleam
/// case fetch.service(env, "AUTH") {
///   Ok(auth) -> todo
///   Error(_) -> worker.internal_server_error() |> promise.resolve
/// }
/// ```
///
pub fn service(env: Env, name: String) -> Result(Target, Nil) {
  js_service_binding(env, name) |> result.map(Target)
}

//
// Sending
//

/// An error that can occur when sending a request.
///
pub type SendError {
  /// The request could not be built, for example because its URL is
  /// invalid, a `GET` request has a body, or a `Bytes` body is not a whole
  /// number of bytes. This is usually a bug in the code building the request.
  InvalidRequest(message: String)
  /// The request could not be sent or no response was received, for example
  /// because the host could not be reached. Retrying may succeed.
  NetworkError(message: String)
  /// The runtime failed in some other way. The message is its error message.
  Unknown(message: String)
}

/// Send a request and wait for the response's status and headers. The
/// response body is not read until you call a function such as `read_text`
/// or `forward`.
///
/// A response with an error status such as 404 or 500 is still `Ok`: the
/// error is only for requests that got no response at all.
///
/// # Examples
///
/// ```gleam
/// let request =
///   request.new()
///   |> request.set_path("/users/1")
///   |> request.set_body(worker.Empty)
/// use result <- promise.await(fetch.send(request, to: api))
/// ```
///
pub fn send(
  request: Request(Body),
  to target: Target,
) -> Promise(Result(Response(ResponseBody), SendError)) {
  case to_js_request(request) {
    Error(message) -> promise.resolve(Error(InvalidRequest(message)))
    Ok(raw) -> {
      use result <- promise.map(js_send(target.fetcher, raw))
      result
      |> result.map(from_js_response)
      |> result.map_error(send_error)
    }
  }
}

/// Classify a failure thrown by `fetch` from its error name. The Fetch API
/// throws a `TypeError` when a request cannot be completed.
///
fn send_error(failure: #(String, String)) -> SendError {
  case failure {
    #("TypeError", message) -> NetworkError(message)
    #(_, message) -> Unknown(message)
  }
}

/// Convert a Gleam request into a Fetch API `Request`. The error is the
/// reason it could not be built.
///
fn to_js_request(request: Request(Body)) -> Result(JsRequest, String) {
  let method = http.method_to_string(request.method)
  let url = request.to_uri(request) |> uri.to_string
  let headers = array.from_list(request.headers)
  case request.body {
    worker.Empty -> js_empty_request(method, url, headers)
    worker.Text(text) -> js_text_request(method, url, headers, text)
    worker.Stream(stream) -> js_stream_request(method, url, headers, stream)
    worker.Bytes(bits) ->
      case worker.is_whole_bytes(bits) {
        True -> js_bytes_request(method, url, headers, bits)
        False -> Error("Request body is not a whole number of bytes")
      }
  }
}

fn from_js_response(raw: JsResponse) -> Response(ResponseBody) {
  Response(
    status: js_response_status(raw),
    headers: array.to_list(js_response_headers(raw)),
    body: ResponseBody(raw),
  )
}

//
// Responses
//

/// The body of a response received with `send`.
///
/// The body is not read until a function such as `read_text` or `forward` is
/// called, and it can only be read once.
///
pub opaque type ResponseBody {
  ResponseBody(raw: JsResponse)
}

/// Read the entire response body as a bit array. A response without a body
/// gives an empty bit array.
///
/// Returns `BodyAlreadyRead` if the body has already been read, and
/// `BodyReadFailed` if it could not be read.
///
pub fn read_bits(
  response: Response(ResponseBody),
) -> Promise(Result(BitArray, BodyError)) {
  let raw = response.body.raw
  case js_response_body_used(raw) {
    True -> promise.resolve(Error(worker.BodyAlreadyRead))
    False -> worker.body_read(js_read_bytes(raw))
  }
}

/// Read the entire response body as a UTF-8 string.
///
/// Returns the same errors as `read_bits`, and `InvalidUtf8` if the body is
/// not valid UTF-8.
///
pub fn read_text(
  response: Response(ResponseBody),
) -> Promise(Result(String, BodyError)) {
  worker.body_string(read_bits(response))
}

/// Turn a received response into a response for the client, with the same
/// status and headers. The body is streamed through without being read into
/// memory.
///
/// Returns `BodyAlreadyRead` if the body has already been read.
///
/// # Examples
///
/// ```gleam
/// use result <- promise.map(fetch.send(request, to: api))
/// case result {
///   Ok(response) ->
///     fetch.forward(response)
///     |> result.unwrap(worker.internal_server_error())
///   Error(_) -> worker.response(502)
/// }
/// ```
///
pub fn forward(
  response: Response(ResponseBody),
) -> Result(worker.Response, BodyError) {
  let raw = response.body.raw
  case js_response_body_used(raw) {
    True -> Error(worker.BodyAlreadyRead)
    False -> {
      let body = case js_response_body(raw) {
        Ok(stream) -> worker.Stream(stream)
        Error(_) -> worker.Empty
      }
      Ok(Response(..response, body:))
    }
  }
}

//
// FFI
//

/// A Fetch API `Request` being sent.
type JsRequest

/// A Fetch API `Response` that was received.
type JsResponse

@external(javascript, "./fetch_ffi.mts", "globalFetcher")
fn js_global_fetcher() -> Fetcher

@external(javascript, "./fetch_ffi.mts", "serviceBinding")
fn js_service_binding(env: Env, name: String) -> Result(Fetcher, Nil)

@external(javascript, "./fetch_ffi.mts", "emptyRequest")
fn js_empty_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
) -> Result(JsRequest, String)

@external(javascript, "./fetch_ffi.mts", "textRequest")
fn js_text_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
  body: String,
) -> Result(JsRequest, String)

@external(javascript, "./fetch_ffi.mts", "bytesRequest")
fn js_bytes_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
  body: BitArray,
) -> Result(JsRequest, String)

@external(javascript, "./fetch_ffi.mts", "streamRequest")
fn js_stream_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
  body: ReadableStream,
) -> Result(JsRequest, String)

@external(javascript, "./fetch_ffi.mts", "send")
fn js_send(
  fetcher: Fetcher,
  request: JsRequest,
) -> Promise(Result(JsResponse, #(String, String)))

@external(javascript, "./fetch_ffi.mts", "responseStatus")
fn js_response_status(response: JsResponse) -> Int

@external(javascript, "./fetch_ffi.mts", "responseHeaders")
fn js_response_headers(response: JsResponse) -> Array(#(String, String))

@external(javascript, "./fetch_ffi.mts", "responseBodyUsed")
fn js_response_body_used(response: JsResponse) -> Bool

@external(javascript, "./fetch_ffi.mts", "responseBody")
fn js_response_body(response: JsResponse) -> Result(ReadableStream, Nil)

@external(javascript, "./worker_ffi.mts", "readBytes")
fn js_read_bytes(response: JsResponse) -> Promise(Result(BitArray, String))
