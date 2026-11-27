//// Add your own spans to
//// [Workers traces](https://developers.cloudflare.com/workers/observability/traces/),
//// alongside the ones Cloudflare records by itself.
////
//// With tracing enabled, Cloudflare already traces each request's handler,
//// every `fetch` from `rays/fetch`, every SQL query from
//// `rays/durable_object/sql`, and every call between Workers and Durable
//// Objects. A span groups that work under a name of your own, with
//// attributes you can filter traces on:
////
//// ```gleam
//// import gleam/javascript/promise.{type Promise}
//// import rays/observability/trace
////
//// fn show_user(id: String, env: Env) -> Promise(Response) {
////   use <- trace.span("load_user", [#("user.id", trace.string(id))])
////   use profile <- promise.await(fetch_profile(id, env))
////   use posts <- promise.await(fetch_posts(id, env))
////   promise.resolve(render(profile, posts))
//// }
//// ```
////
//// Spans nest by themselves: the fetches above, and any spans started while
//// they run, become children of `load_user`. A span whose function returns
//// a promise ends when the promise settles.
////
//// A Gleam `Error` is a value, not an exception, so Cloudflare can't tell a
//// failed operation from a successful one. `try` marks the span as failed
//// when the result is an `Error`.
////
//// `rays/worker` also traces each request without any code: it names the
//// handler's span after the request's method and path, with segments that
//// look like IDs replaced by `:id`, such as `GET /users/:id`. It records the
//// response's status, marks 5xx responses as failed, and records where in
//// the Gleam code a panic happened.
////
//// ## Enabling tracing
////
//// Tracing is off until it is enabled in the Worker's configuration, since
//// Cloudflare bills for stored traces. Until then, every function here does
//// nothing but run the code it is given, so spans can be left in place.
////
//// ```ts
//// // cloudflare.config.ts
//// worker: raysWorker({
////   name: "my-app",
////   compatibilityDate: "2026-09-01",
////   observability: { traces: { enabled: true, headSamplingRate: 0.05 } },
//// }),
//// ```
////
//// `wrangler dev` and `vite dev` record traces locally, shown in Local
//// Explorer.
////
//// ## What to trace
////
//// The Workers runtime only advances its clock on I/O, so a span around
//// Gleam code that does no I/O usually lasts 0 ms. Spans are most useful
//// around work that waits on something, such as a group of fetches or
//// queries.
////
//// Logs written with `rays/observability/log` inside a span are attached to it. Keep
//// secrets and personal data out of attributes, and keep attributes small:
//// Cloudflare drops an attribute that is too large.

import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}

//
// Spans
//

/// A span in a trace. Get one from `span_with` or `current`.
///
/// When tracing is not enabled, or outside a request, a span is a
/// placeholder that ignores everything done to it.
///
pub type Span

/// The value of an attribute: a string, an integer, a float, or a bool.
/// Build one with `string`, `int`, `float`, or `bool`.
///
pub type Value

/// An attribute value of text.
///
@external(javascript, "./trace_ffi.mts", "attribute")
pub fn string(value: String) -> Value

/// An attribute value of a whole number.
///
@external(javascript, "./trace_ffi.mts", "attribute")
pub fn int(value: Int) -> Value

/// An attribute value of a number with a fractional part.
///
@external(javascript, "./trace_ffi.mts", "attribute")
pub fn float(value: Float) -> Value

/// An attribute value of true or false.
///
@external(javascript, "./trace_ffi.mts", "attribute")
pub fn bool(value: Bool) -> Value

/// Whether the operation a span covers succeeded. Cloudflare includes it in
/// traces exported to an OpenTelemetry destination, though the Cloudflare
/// dashboard does not yet show it.
///
pub type Status {
  /// The operation succeeded. Once a span has succeeded, later statuses are
  /// ignored.
  Succeeded
  /// The operation failed, for the reason given.
  Failed(message: String)
}

/// Run `run` in a new span with the given name and attributes. Returns what
/// `run` returns.
///
/// The span is a child of the span active when it starts, and is the parent
/// of the spans started while `run` runs, including those Cloudflare records
/// for fetches and queries. If `run` returns a promise, the span ends when
/// the promise settles, and otherwise when `run` returns.
///
/// # Examples
///
/// ```gleam
/// pub fn post(params: Params(String, Room)) -> Promise(Int) {
///   use <- trace.span("chat_room.post", [
///     #("message.length", trace.int(string.length(params.args))),
///   ])
///   // ...
/// }
/// ```
///
pub fn span(
  name: String,
  attributes: List(#(String, Value)),
  run: fn() -> a,
) -> a {
  span_with(name, attributes, fn(_span) { run() })
}

/// Like `span`, but gives the span to `run`, to add attributes that are only
/// known once the work has started.
///
/// # Examples
///
/// ```gleam
/// use span <- trace.span_with("load_posts", [])
/// use posts <- promise.map(fetch_posts(env))
/// trace.set_attributes(span, [#("post.count", trace.int(list.length(posts)))])
/// posts
/// ```
///
pub fn span_with(
  name: String,
  attributes: List(#(String, Value)),
  run: fn(Span) -> a,
) -> a {
  js_enter_span(name, array.from_list(attributes), run)
}

/// Run `run` in a new span, as `span` does, and set the span's status from
/// the result: `Succeeded` for `Ok`, and `Failed` for `Error`, with a message
/// from `describe`.
///
/// `describe` decides what of an error reaches the trace, so leave out
/// anything secret or personal, such as the user's input. Inside `run`,
/// `current` is the new span.
///
/// # Examples
///
/// ```gleam
/// use result <- promise.await({
///   use <- trace.try(
///     "charge_card",
///     [#("cart.total_cents", trace.int(cart.total_cents))],
///     describe: payment.error_to_string,
///   )
///   payment.charge(cart, env)
/// })
/// ```
///
pub fn try(
  name: String,
  attributes: List(#(String, Value)),
  describe describe: fn(error) -> String,
  run run: fn() -> Promise(Result(value, error)),
) -> Promise(Result(value, error)) {
  use span <- span_with(name, attributes)
  use result <- promise.map(run())
  let status = case result {
    Ok(_) -> Succeeded
    Error(error) -> Failed(describe(error))
  }
  set_status(span, status)
  result
}

/// The active span: the innermost span started with `span`, `span_with`, or
/// `try` that is still running, or otherwise the span Cloudflare records for
/// the request's handler.
///
/// Outside a request, such as when a module loads, it is a placeholder.
///
/// # Examples
///
/// ```gleam
/// trace.current()
/// |> trace.set_attributes([#("user.plan", trace.string(plan))])
/// ```
///
@external(javascript, "./trace_ffi.mts", "activeSpan")
pub fn current() -> Span

/// Add attributes to a span. An attribute with the same name as one already
/// on the span replaces it.
///
pub fn set_attributes(span: Span, attributes: List(#(String, Value))) -> Span {
  js_set_attributes(span, array.from_list(attributes))
}

/// Set whether the operation a span covers succeeded.
///
pub fn set_status(span: Span, status: Status) -> Span {
  case status {
    Succeeded -> js_set_status_ok(span)
    Failed(message:) -> js_set_status_error(span, message)
  }
}

/// Change a span's name, such as the name `rays/worker` gives the request's
/// span when its guess at the route is wrong.
///
/// # Examples
///
/// ```gleam
/// // GET /posts/hello-world, which rays can't tell is a slug.
/// trace.current() |> trace.rename("GET /posts/:slug")
/// ```
///
@external(javascript, "./trace_ffi.mts", "updateName")
pub fn rename(span: Span, name: String) -> Span

/// The ID of the trace a span is part of, as shown in the Cloudflare
/// dashboard and in exported traces. Log it, or send it to the client, to
/// find the trace of a request later.
///
/// Returns an error when tracing and logs are both disabled, or outside a
/// request. An ID is still returned when the request was not sampled for
/// tracing, but no trace is stored under it.
///
pub fn trace_id(span: Span) -> Result(String, Nil) {
  case js_trace_id(span) {
    "00000000000000000000000000000000" -> Error(Nil)
    id -> Ok(id)
  }
}

//
// FFI
//

@external(javascript, "./trace_ffi.mts", "enterSpan")
fn js_enter_span(
  name: String,
  attributes: Array(#(String, Value)),
  run: fn(Span) -> a,
) -> a

@external(javascript, "./trace_ffi.mts", "setAttributes")
fn js_set_attributes(span: Span, attributes: Array(#(String, Value))) -> Span

@external(javascript, "./trace_ffi.mts", "setStatusOk")
fn js_set_status_ok(span: Span) -> Span

@external(javascript, "./trace_ffi.mts", "setStatusError")
fn js_set_status_error(span: Span, message: String) -> Span

@external(javascript, "./trace_ffi.mts", "traceId")
fn js_trace_id(span: Span) -> String
