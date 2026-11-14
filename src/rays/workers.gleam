//// Write Cloudflare Workers in Gleam.
////
//// The API follows [Wisp](https://hexdocs.pm/wisp): requests and responses
//// are `gleam_http` types, routing is plain pattern matching, and middleware
//// is written with `use`. The difference is that Workers are asynchronous, so
//// handlers return a `Promise(Response)`.
////
//// ```gleam
//// import gleam/javascript/promise.{type Promise}
//// import rays/workers.{type Context, type Env, type Request, type Response}
////
//// pub fn main() -> workers.Worker {
////   workers.new(handle_request)
//// }
////
//// fn handle_request(req: Request, _env: Env, _ctx: Context) -> Promise(Response) {
////   case workers.path_segments(req) {
////     [] -> workers.ok() |> workers.html_body("<h1>Hello!</h1>") |> promise.resolve
////     _ -> promise.resolve(workers.not_found())
////   }
//// }
//// ```
////
//// The worker is exported to Cloudflare from a small entry module:
////
//// ```ts
//// // index.mts
//// import { main } from "./build/dev/javascript/my_app/my_app.mjs";
//// export default main();
//// ```

import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/http.{type Method}
import gleam/http/request.{type Request as HttpRequest}
import gleam/http/response.{type Response as HttpResponse, Response}
import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string
import gleam/uri

//
// Worker
//

/// A Cloudflare Worker, ready to be exported as the default export of the
/// Worker's entry module.
///
/// At runtime this is the `ExportedHandler` object Cloudflare expects, with a
/// `fetch` method, so a JavaScript entry module can `export default main()`.
/// It also has a `Symbol.for("rays.worker")` property set to `true`, which
/// `handler()` from the `@rays/cloudflare` npm package checks for. Both are
/// stable parts of the runtime shape.
///
pub type Worker

/// The bindings configured for the Worker: environment variables, secrets,
/// and resources such as KV namespaces or D1 databases.
///
pub type Env

/// The Worker's execution context, used to extend the lifetime of the
/// request with `wait_until` and to control failure behaviour with
/// `pass_through_on_exception`.
///
pub type Context

/// A function that handles an incoming HTTP request.
///
pub type Handler =
  fn(Request, Env, Context) -> Promise(Response)

/// The raw Fetch API `Request` object provided by the Workers runtime.
@internal
pub type JsRequest

/// The raw Fetch API `Response` object handed back to the Workers runtime.
type JsResponse

/// Create a Worker that handles HTTP requests with the given handler.
///
/// # Examples
///
/// ```gleam
/// pub fn main() -> workers.Worker {
///   workers.new(handle_request)
/// }
/// ```
///
pub fn new(handler: Handler) -> Worker {
  make_worker(fn(raw, env, ctx) {
    case from_js_request(raw) {
      Ok(request) -> handler(request, env, ctx) |> promise.map(to_js_response)
      Error(detail) -> promise.resolve(to_js_response(bad_request(detail)))
    }
  })
}

/// Convert a Fetch API `Request` into a Gleam request. The error is a detail
/// for the 400 response. The Workers runtime validates methods and URLs, so
/// in practice only a non-HTTP URL scheme can fail here.
///
fn from_js_request(raw: JsRequest) -> Result(Request, String) {
  use uri <- result.try(
    uri.parse(js_request_url(raw)) |> result.replace_error("Invalid URL"),
  )
  use request <- result.try(
    request.from_uri(uri) |> result.replace_error("Unsupported URL scheme"),
  )
  use method <- result.try(
    http.parse_method(js_request_method(raw))
    |> result.replace_error("Invalid method"),
  )
  Ok(
    request.Request(
      ..request,
      method:,
      headers: array.to_list(js_request_headers(raw)),
      body: RequestBody(raw),
    ),
  )
}

/// Convert a Gleam response into a Fetch API `Response`.
///
/// The body is dropped for statuses that the Fetch API forbids a body on,
/// and a `Bytes` body that is not a whole number of bytes becomes a 500
/// response, as neither can be sent to the client.
///
fn to_js_response(response: Response) -> JsResponse {
  let Response(status:, headers:, body:) = response
  let headers = array.from_list(headers)
  case status, body {
    101, _ | 204, _ | 205, _ | 304, _ | _, Empty ->
      js_empty_response(status, headers)
    _, Text(text) -> js_text_response(status, headers, text)
    _, Stream(stream) -> js_stream_response(status, headers, stream)
    _, Bytes(bits) ->
      case is_whole_bytes(bits) {
        True -> js_bytes_response(status, headers, bits)
        False -> to_js_response(internal_server_error())
      }
  }
}

//
// Env & Context
//

/// Get a string environment variable or secret from the Worker's bindings.
///
/// Returns an error if there is no binding with that name, or if the binding
/// is not a string (for example a KV namespace).
///
/// # Examples
///
/// ```gleam
/// case workers.env_var(env, "API_TOKEN") {
///   Ok(token) -> todo
///   Error(_) -> workers.internal_server_error() |> promise.resolve
/// }
/// ```
///
@external(javascript, "./workers_ffi.mts", "envVar")
pub fn env_var(env: Env, name: String) -> Result(String, Nil)

/// Get any binding from the Worker's environment as a dynamic value.
///
/// Returns an error if there is no binding with that name, or if its value
/// is `null`.
///
/// This is an escape hatch for bindings that `rays` does not yet provide
/// typed APIs for.
///
@external(javascript, "./workers_ffi.mts", "envBinding")
pub fn env_binding(env: Env, name: String) -> Result(Dynamic, Nil)

/// Extend the lifetime of the Worker until the given promise settles, without
/// delaying the response. Useful for logging, analytics, or cache writes.
///
@external(javascript, "./workers_ffi.mts", "waitUntil")
pub fn wait_until(ctx: Context, promise: Promise(a)) -> Nil

/// If the Worker throws an unhandled exception, forward the request to the
/// origin server instead of returning an error page.
///
@external(javascript, "./workers_ffi.mts", "passThroughOnException")
pub fn pass_through_on_exception(ctx: Context) -> Nil

//
// Requests
//

/// The body of an incoming request.
///
/// The body is not read until one of the body reading functions such as
/// `read_body_bits` or `require_string_body` is called. A body can only be
/// read once.
///
/// Internally this holds the whole Fetch API `Request`, because Cloudflare's
/// `cf` properties are read from it too. The method, URL, and headers are
/// only taken from the Gleam request record.
///
pub opaque type RequestBody {
  RequestBody(raw: JsRequest)
}

/// Wrap a JS `Request` as a request body. Used by `rays/workers/simulate`,
/// which builds the JS `Request` itself.
///
@internal
pub fn request_body(raw: JsRequest) -> RequestBody {
  RequestBody(raw)
}

/// An incoming HTTP request.
///
pub type Request =
  HttpRequest(RequestBody)

/// A streaming body, such as an incoming request body or the body of a
/// response from `fetch`.
///
pub type ReadableStream

/// An error that can occur when reading the body of an incoming request, or
/// of a response received with `rays/fetch`.
///
pub type BodyError {
  /// The body has already been read by an earlier call.
  BodyAlreadyRead
  /// The body could not be read from the client, for example because the
  /// connection was lost. The reason is the runtime's error message.
  BodyReadFailed(reason: String)
  /// The body was read but is not valid UTF-8.
  InvalidUtf8
}

/// Split the request path into its segments.
///
/// # Examples
///
/// ```gleam
/// // GET /users/123
/// workers.path_segments(request)
/// // -> ["users", "123"]
/// ```
///
pub fn path_segments(request: Request) -> List(String) {
  request.path_segments(request)
}

/// Get the query parameters of the request. Returns an empty list if the
/// query string is missing or malformed.
///
pub fn get_query(request: Request) -> List(#(String, String)) {
  request.get_query(request)
  |> result.unwrap([])
}

/// Get Cloudflare's `cf` properties for the request, such as the client's
/// country, the data centre that handled the request, and TLS details.
///
/// Returns an error when running outside Cloudflare, for example in tests.
///
pub fn cf_properties(request: Request) -> Result(Dynamic, Nil) {
  js_request_cf(request.body.raw)
}

/// Get the request body as a stream, without reading it into memory. A
/// request without a body gives an empty stream.
///
/// Returns `BodyAlreadyRead` if the body has already been read.
///
pub fn body_stream(request: Request) -> Result(ReadableStream, BodyError) {
  case js_body_used(request.body.raw) {
    True -> Error(BodyAlreadyRead)
    False -> Ok(js_body_stream(request.body.raw))
  }
}

/// Type the result of reading a body that has not been read already: the
/// runtime's failure message becomes `BodyReadFailed`. Used by `rays/fetch`
/// for the bodies of responses it receives.
///
@internal
pub fn body_read(
  read: Promise(Result(BitArray, String)),
) -> Promise(Result(BitArray, BodyError)) {
  read |> promise.map(result.map_error(_, BodyReadFailed))
}

/// Type the result of reading a body as UTF-8: invalid bytes become
/// `InvalidUtf8`. Used by `rays/fetch` for the bodies of responses it
/// receives.
///
@internal
pub fn body_string(
  read: Promise(Result(BitArray, BodyError)),
) -> Promise(Result(String, BodyError)) {
  use bits <- promise.map(read)
  use bits <- result.try(bits)
  bit_array.to_string(bits) |> result.replace_error(InvalidUtf8)
}

/// Read the entire request body as a bit array. A request without a body
/// gives an empty bit array.
///
/// Returns `BodyAlreadyRead` if the body has already been read, and
/// `BodyReadFailed` if it could not be read.
///
pub fn read_body_bits(
  request: Request,
) -> Promise(Result(BitArray, BodyError)) {
  case js_body_used(request.body.raw) {
    True -> promise.resolve(Error(BodyAlreadyRead))
    False -> body_read(js_read_bytes(request.body.raw))
  }
}

/// Read the entire request body as a UTF-8 string.
///
/// Returns the same errors as `read_body_bits`, and `InvalidUtf8` if the
/// body is not valid UTF-8.
///
pub fn read_body_string(
  request: Request,
) -> Promise(Result(String, BodyError)) {
  body_string(read_body_bits(request))
}

fn body_error_response(error: BodyError) -> Response {
  case error {
    BodyAlreadyRead -> internal_server_error()
    BodyReadFailed(_) -> bad_request("Could not read body")
    InvalidUtf8 -> bad_request("Invalid UTF-8")
  }
}

//
// Middleware
//

/// Ensure the request has the given method, responding with 405: Method not
/// allowed otherwise.
///
/// # Examples
///
/// ```gleam
/// use <- workers.require_method(req, http.Post)
/// ```
///
pub fn require_method(
  request: HttpRequest(body),
  method: Method,
  next: fn() -> Promise(Response),
) -> Promise(Response) {
  case request.method == method {
    True -> next()
    False -> promise.resolve(method_not_allowed(allowed: [method]))
  }
}

/// Ensure the request has the given media type, responding with 415:
/// Unsupported media type otherwise.
///
/// The comparison ignores case and parameters such as `; charset=utf-8`, so
/// `"application/json"` matches `Application/JSON; charset=utf-8`.
///
pub fn require_content_type(
  request: HttpRequest(body),
  expected: String,
  next: fn() -> Promise(Response),
) -> Promise(Response) {
  let matches = case request.get_header(request, "content-type") {
    Ok(content_type) -> media_type(content_type) == media_type(expected)
    Error(_) -> False
  }
  case matches {
    True -> next()
    False -> promise.resolve(unsupported_media_type(accept: [expected]))
  }
}

/// The media type of a content type, without parameters, lowercased.
///
fn media_type(content_type: String) -> String {
  case string.split_once(content_type, ";") {
    Ok(#(media_type, _)) -> media_type
    Error(_) -> content_type
  }
  |> string.trim
  |> string.lowercase
}

/// Read the request body as a bit array.
///
/// Responds with 400: Bad request if the body cannot be read.
///
pub fn require_bit_array_body(
  request: Request,
  next: fn(BitArray) -> Promise(Response),
) -> Promise(Response) {
  use result <- promise.await(read_body_bits(request))
  case result {
    Ok(bits) -> next(bits)
    Error(error) -> promise.resolve(body_error_response(error))
  }
}

/// Read the request body as a UTF-8 string.
///
/// Responds with 400: Bad request if the body cannot be read or is not valid
/// UTF-8.
///
/// # Examples
///
/// ```gleam
/// use body <- workers.require_string_body(req)
/// ```
///
pub fn require_string_body(
  request: Request,
  next: fn(String) -> Promise(Response),
) -> Promise(Response) {
  use result <- promise.await(read_body_string(request))
  case result {
    Ok(body) -> next(body)
    Error(error) -> promise.resolve(body_error_response(error))
  }
}

/// Read the request body as JSON, returning a dynamic value to be decoded.
///
/// Responds with 415: Unsupported media type if the content type is not
/// `application/json`, and with 400: Bad request if the body is not valid
/// JSON.
///
/// # Examples
///
/// ```gleam
/// use value <- workers.require_json(req)
/// case decode.run(value, person_decoder()) {
///   Ok(person) -> todo
///   Error(_) -> workers.unprocessable_content() |> promise.resolve
/// }
/// ```
///
pub fn require_json(
  request: Request,
  next: fn(Dynamic) -> Promise(Response),
) -> Promise(Response) {
  use <- require_content_type(request, "application/json")
  use body <- require_string_body(request)
  case json.parse(body, decode.dynamic) {
    Ok(value) -> next(value)
    Error(_) -> promise.resolve(bad_request("Invalid JSON"))
  }
}

/// Read a `application/x-www-form-urlencoded` request body as a list of
/// key-value pairs, sorted by key.
///
/// Responds with 415: Unsupported media type for any other content type, and
/// with 400: Bad request if the body is not a valid form encoding.
///
/// Multipart form bodies are not yet supported.
///
pub fn require_form(
  request: Request,
  next: fn(List(#(String, String))) -> Promise(Response),
) -> Promise(Response) {
  use <- require_content_type(request, "application/x-www-form-urlencoded")
  use body <- require_string_body(request)
  case uri.parse_query(body) {
    Ok(pairs) -> next(list.sort(pairs, fn(a, b) { string.compare(a.0, b.0) }))
    Error(_) -> promise.resolve(bad_request("Invalid form encoding"))
  }
}

//
// Responses
//

/// The body of an HTTP response.
///
/// The body is not sent for statuses that cannot have one (101, 204, 205,
/// and 304).
///
pub type Body {
  /// A body of UTF-8 text.
  Text(String)
  /// A body of binary data. If it is not a whole number of bytes, a 500
  /// response is sent instead.
  Bytes(BitArray)
  /// A streaming body, passed through to the client without buffering.
  Stream(ReadableStream)
  /// No body.
  Empty
}

/// Whether the bit array is a whole number of bytes, as the Fetch API
/// requires of a binary body. Used by `rays/fetch` and `rays/workers/simulate`
/// as well.
///
@internal
pub fn is_whole_bytes(bits: BitArray) -> Bool {
  bit_array.bit_size(bits) % 8 == 0
}

/// An HTTP response.
///
pub type Response =
  HttpResponse(Body)

const content_text = #("content-type", "text/plain; charset=utf-8")

/// A response with a plain text body.
///
fn plain_text(status: Int, text: String) -> Response {
  Response(status, [content_text], Text(text))
}

/// Create a response with the given status code and no body.
///
pub fn response(status: Int) -> Response {
  Response(status, [], Empty)
}

/// Set the body of a response.
///
pub fn set_body(response: HttpResponse(a), body: Body) -> Response {
  response.set_body(response, body)
}

/// Set a header on a response, replacing any existing header with the same
/// name.
///
pub fn set_header(
  response: HttpResponse(a),
  name: String,
  value: String,
) -> HttpResponse(a) {
  response.set_header(response, name, value)
}

/// Set the body of a response to the given text. The content type is not
/// changed.
///
pub fn string_body(response: HttpResponse(a), content: String) -> Response {
  response.set_body(response, Text(content))
}

/// Set the body of a response to the given binary data. The content type is
/// not changed.
///
pub fn bit_array_body(
  response: HttpResponse(a),
  content: BitArray,
) -> Response {
  response.set_body(response, Bytes(content))
}

/// Set the body of a response to a stream. The content type is not changed.
///
pub fn stream_body(
  response: HttpResponse(a),
  stream: ReadableStream,
) -> Response {
  response.set_body(response, Stream(stream))
}

/// Set the body of a response to the given HTML, and set the content type to
/// `text/html`.
///
pub fn html_body(response: HttpResponse(a), html: String) -> Response {
  response
  |> response.set_body(Text(html))
  |> response.set_header("content-type", "text/html; charset=utf-8")
}

/// Set the body of a response to the given JSON, and set the content type to
/// `application/json`.
///
pub fn json_body(response: HttpResponse(a), data: Json) -> Response {
  response
  |> response.set_body(Text(json.to_string(data)))
  |> response.set_header("content-type", "application/json; charset=utf-8")
}

/// Create an HTML response with the given status code.
///
pub fn html_response(html: String, status: Int) -> Response {
  response(status) |> html_body(html)
}

/// Create a JSON response with the given status code.
///
/// # Examples
///
/// ```gleam
/// json.object([#("name", json.string("Joe"))])
/// |> workers.json_response(201)
/// ```
///
pub fn json_response(data: Json, status: Int) -> Response {
  response(status) |> json_body(data)
}

/// A 200: OK response.
///
pub fn ok() -> Response {
  plain_text(200, "OK")
}

/// A 201: Created response.
///
pub fn created() -> Response {
  plain_text(201, "Created")
}

/// A 202: Accepted response.
///
pub fn accepted() -> Response {
  plain_text(202, "Accepted")
}

/// A 204: No content response.
///
pub fn no_content() -> Response {
  Response(204, [], Empty)
}

/// A 303: See other response, redirecting the client to the given URL with a
/// GET request.
///
pub fn redirect(to url: String) -> Response {
  redirect_with(303, url)
}

/// A 308: Permanent redirect response.
///
pub fn permanent_redirect(to url: String) -> Response {
  redirect_with(308, url)
}

fn redirect_with(status: Int, url: String) -> Response {
  plain_text(status, "You are being redirected: " <> url)
  |> response.prepend_header("location", url)
}

/// A 400: Bad request response. The detail is included in the body if it is
/// not empty.
///
pub fn bad_request(detail: String) -> Response {
  let body = case detail {
    "" -> "Bad request"
    _ -> "Bad request: " <> detail
  }
  plain_text(400, body)
}

/// A 404: Not found response.
///
pub fn not_found() -> Response {
  plain_text(404, "Not found")
}

/// A 405: Method not allowed response, listing the allowed methods.
///
pub fn method_not_allowed(allowed methods: List(Method)) -> Response {
  let allowed =
    methods
    |> list.map(http.method_to_string)
    |> list.map(string.uppercase)
    |> list.sort(string.compare)
    |> string.join(", ")
  plain_text(405, "Method not allowed")
  |> response.prepend_header("allow", allowed)
}

/// A 413: Content too large response.
///
pub fn content_too_large() -> Response {
  plain_text(413, "Content too large")
}

/// A 415: Unsupported media type response, listing the accepted media types.
///
pub fn unsupported_media_type(accept acceptable: List(String)) -> Response {
  plain_text(415, "Unsupported media type")
  |> response.prepend_header("accept", string.join(acceptable, ", "))
}

/// A 422: Unprocessable content response.
///
pub fn unprocessable_content() -> Response {
  plain_text(422, "Unprocessable content")
}

/// A 500: Internal server error response.
///
pub fn internal_server_error() -> Response {
  plain_text(500, "Internal server error")
}

//
// FFI
//

@external(javascript, "./workers_ffi.mts", "makeWorker")
fn make_worker(
  fetch: fn(JsRequest, Env, Context) -> Promise(JsResponse),
) -> Worker

@external(javascript, "./workers_ffi.mts", "requestMethod")
fn js_request_method(request: JsRequest) -> String

@external(javascript, "./workers_ffi.mts", "requestUrl")
fn js_request_url(request: JsRequest) -> String

@external(javascript, "./workers_ffi.mts", "requestHeaders")
fn js_request_headers(request: JsRequest) -> Array(#(String, String))

@external(javascript, "./workers_ffi.mts", "requestCf")
fn js_request_cf(request: JsRequest) -> Result(Dynamic, Nil)

@external(javascript, "./workers_ffi.mts", "bodyUsed")
fn js_body_used(request: JsRequest) -> Bool

@external(javascript, "./workers_ffi.mts", "bodyStream")
fn js_body_stream(request: JsRequest) -> ReadableStream

@external(javascript, "./workers_ffi.mts", "readBytes")
fn js_read_bytes(request: JsRequest) -> Promise(Result(BitArray, String))

@external(javascript, "./workers_ffi.mts", "textResponse")
fn js_text_response(
  status: Int,
  headers: Array(#(String, String)),
  body: String,
) -> JsResponse

@external(javascript, "./workers_ffi.mts", "bytesResponse")
fn js_bytes_response(
  status: Int,
  headers: Array(#(String, String)),
  body: BitArray,
) -> JsResponse

@external(javascript, "./workers_ffi.mts", "streamResponse")
fn js_stream_response(
  status: Int,
  headers: Array(#(String, String)),
  body: ReadableStream,
) -> JsResponse

@external(javascript, "./workers_ffi.mts", "emptyResponse")
fn js_empty_response(
  status: Int,
  headers: Array(#(String, String)),
) -> JsResponse
