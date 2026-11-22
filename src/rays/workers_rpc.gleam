//// Call one Worker from another with
//// [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/),
//// passing and returning ordinary Gleam values.
////
//// A method is a public function that takes `Params` and returns a
//// `Promise`. The Worker that serves it binds it, and the Worker that calls
//// it passes the same function to `call`, so both ends agree on its argument
//// and reply types:
////
//// ```gleam
//// // src/app/names.gleam
//// import gleam/javascript/promise.{type Promise}
//// import gleam/list
//// import gleam/string
//// import rays/workers
//// import rays/workers_rpc
////
//// pub fn main() -> workers.Worker {
////   workers.new(fn(_request, _env, _ctx) { promise.resolve(workers.not_found()) })
////   |> workers_rpc.bind(search)
//// }
////
//// pub type Search {
////   Search(query: String, limit: Int)
//// }
////
//// pub fn search(params: workers_rpc.Params(Search)) -> Promise(List(String)) {
////   let Search(query:, limit:) = params.args
////   ["Ada", "Adam", "Grace"]
////   |> list.filter(string.starts_with(_, query))
////   |> list.take(limit)
////   |> promise.resolve
//// }
//// ```
////
//// ```gleam
//// // src/app.gleam, a Worker with a service binding NAMES to the one above
//// import app/names
//// import gleam/javascript/promise.{type Promise}
//// import gleam/string
//// import rays/workers.{type Context, type Env, type Request, type Response}
//// import rays/workers_rpc
////
//// pub fn handle_request(
////   _request: Request,
////   env: Env,
////   _ctx: Context,
//// ) -> Promise(Response) {
////   case workers_rpc.service(env, "NAMES") {
////     Ok(service) -> {
////       let call = workers_rpc.call(service, names.search, names.Search("Ad", 2))
////       use found <- promise.map(call)
////       case found {
////         Ok(found) ->
////           workers.ok() |> workers.string_body(string.join(found, ", "))
////         Error(_) -> workers.response(502)
////       }
////     }
////     Error(Nil) -> promise.resolve(workers.internal_server_error())
////   }
//// }
//// ```
////
//// This code is compiled and tested in rays's own test suite.
////
//// ## How it works
////
//// Workers RPC can't send Gleam values as they are, so `rays build` and the
//// `rays()` Vite plugin do two things when they build the project:
////
//// - They register every custom type in the project and its dependencies,
////   so values can be encoded on one side and rebuilt as the same types on
////   the other.
//// - They find every RPC method in the package, and give the Worker's entry
////   module one Workers RPC method with the same name for each.
////
//// So a method must be a public function in the package itself, not a
//// dependency, whose only argument is a `workers_rpc.Params` and which
//// returns a `Promise`. A Worker that binds anything else fails to start.
//// Its name is the name of the Workers RPC method, which is what
//// TypeScript callers and the Cloudflare dashboard see. A Worker built only
//// with `gleam build` can still be tested with
//// `rays/workers/simulate.with_rpc_service`.
////
//// Both Workers must be built from the same code for a method's types. Each
//// method has a version, a hash of its argument and reply types and of the
//// types they contain. A call to a Worker with a different version fails
//// with `VersionMismatch` instead of decoding the wrong values, so deploy
//// both Workers when those types change. Changing a method's handler doesn't
//// change its version.
////
//// Functions can't be sent, and neither can values that only make sense
//// inside one Worker, such as a request body or a stream.

import gleam/javascript/promise.{type Promise}
import gleam/result
import rays/workers.{type Context, type Env, type Worker}

/// What a method receives: the argument sent by the caller, and the serving
/// Worker's bindings and context.
///
/// Several values go in a record or a tuple, and `Nil` stands for none.
///
/// # Examples
///
/// ```gleam
/// pub fn display_name(params: workers_rpc.Params(Int)) -> Promise(String) {
///   users.display_name(params.env, params.args)
/// }
/// ```
///
pub type Params(args) {
  Params(args: args, env: Env, context: Context)
}

/// Serve a method from this Worker, so other Workers can `call` it.
///
/// The method is a public function in this package whose only argument is a
/// `Params`, or the Worker fails to start when it is built with rays.
///
/// The reply is sent back to the caller. If the method panics, or its
/// promise rejects, the caller gets a `HandlerFailed` error instead. Errors
/// the caller should handle belong in the reply type, as in
/// `Promise(Result(User, LookupError))`.
///
/// # Examples
///
/// ```gleam
/// pub fn main() -> workers.Worker {
///   workers.new(handle_request)
///   |> workers_rpc.bind(display_name)
///   |> workers_rpc.bind(search)
/// }
/// ```
///
pub fn bind(
  worker: Worker,
  method: fn(Params(args)) -> Promise(reply),
) -> Worker {
  js_bind(worker, method, fn(args, env, context) {
    method(Params(args:, env:, context:))
  })
}

/// Another Worker, reached through a service binding, whose methods can be
/// called with `call`.
///
pub type Service

/// Get the Worker bound to the given name, through a service binding.
///
/// Returns an error if there is no binding with that name. Whether the
/// binding really is a rays Worker is only known when a method is called.
///
/// # Examples
///
/// ```gleam
/// case workers_rpc.service(env, "NAMES") {
///   Ok(names) -> todo
///   Error(Nil) -> workers.internal_server_error() |> promise.resolve
/// }
/// ```
///
@external(javascript, "./workers_rpc_ffi.mts", "service")
pub fn service(env: Env, name: String) -> Result(Service, Nil)

/// An error that can occur when calling a method on another Worker.
///
/// Every variant but `NotAMethod` has the name of the method called.
///
pub type CallError {
  /// The function passed to `call` isn't an RPC method that rays found. It
  /// must be a public function in this package whose only argument is a
  /// `Params`, and the Worker must be built with rays.
  NotAMethod
  /// The other Worker doesn't bind this method.
  NotBound(method: String)
  /// The other Worker was built from a different version of this method's
  /// argument or reply types. Deploy both Workers.
  VersionMismatch(method: String)
  /// The method's handler panicked, or its promise rejected.
  HandlerFailed(method: String, message: String)
  /// The call didn't reach the other Worker, or the runtime failed while
  /// making it, for example because the binding isn't a rays Worker.
  SendFailed(method: String, message: String)
  /// A value couldn't be encoded to be sent, such as an argument or reply
  /// that holds a function.
  EncodeFailed(method: String, message: String)
  /// A value that was sent couldn't be decoded, usually because the two
  /// Workers were built from different code.
  DecodeFailed(method: String, message: String)
}

/// Call a method on another Worker.
///
/// Pass the method's function itself. The argument and reply types are the
/// method's own, so they are checked when both Workers are compiled.
///
/// The outer `Result` says whether the call happened. Errors the method
/// itself returns are part of its reply type.
///
/// # Examples
///
/// ```gleam
/// use name <- promise.await(workers_rpc.call(names, names.display_name, 42))
/// case name {
///   Ok(name) -> workers.ok() |> workers.string_body(name) |> promise.resolve
///   Error(_) -> workers.response(502) |> promise.resolve
/// }
/// ```
///
pub fn call(
  service: Service,
  method: fn(Params(args)) -> Promise(reply),
  args: args,
) -> Promise(Result(reply, CallError)) {
  use outcome <- promise.map(js_call(service, method, args))
  result.map_error(outcome, to_call_error)
}

fn to_call_error(failure: #(String, String, String)) -> CallError {
  let #(kind, method, message) = failure
  case kind {
    "not_a_method" -> NotAMethod
    "not_bound" -> NotBound(method:)
    "version_mismatch" -> VersionMismatch(method:)
    "handler" -> HandlerFailed(method:, message:)
    "encode" -> EncodeFailed(method:, message:)
    "decode" -> DecodeFailed(method:, message:)
    _ -> SendFailed(method:, message:)
  }
}

@external(javascript, "./workers_rpc_ffi.mts", "bind")
fn js_bind(
  worker: Worker,
  method: fn(Params(args)) -> Promise(reply),
  handler: fn(args, Env, Context) -> Promise(reply),
) -> Worker

@external(javascript, "./workers_rpc_ffi.mts", "call")
fn js_call(
  service: Service,
  method: fn(Params(args)) -> Promise(reply),
  args: args,
) -> Promise(Result(reply, #(String, String, String)))
