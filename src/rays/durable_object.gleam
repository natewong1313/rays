//// Write Cloudflare
//// [Durable Objects](https://developers.cloudflare.com/durable-objects/) in
//// Gleam, and call their methods from Workers.
////
//// A Durable Object class is a function with no arguments that returns a
//// `DurableObject`. Each instance of the class holds **memory**: a Gleam
//// value of any type, which starts as the value given to `new` each time
//// the instance wakes. Cloudflare evicts an instance that has been idle for
//// a while, and its memory goes with it, so the next call wakes it again.
//// Anything that must outlive an eviction belongs in the instance's SQLite
//// database, which `rays/durable_object/sql` queries.
////
//// The class's RPC methods read its memory with `read_memory` and change it
//// with `update_memory`:
////
//// ```gleam
//// // src/app/chat_room.gleam
//// import gleam/javascript/promise.{type Promise}
//// import gleam/list
//// import rays/durable_object.{type DurableObject, type Params}
////
//// pub type Room {
////   Room(messages: List(String))
//// }
////
//// pub fn chat_room() -> DurableObject(Room) {
////   durable_object.new(Room(messages: []))
////   |> durable_object.bind(post)
////   |> durable_object.bind(recent)
//// }
////
//// pub fn post(params: Params(String, Room)) -> Promise(Int) {
////   let room =
////     durable_object.update_memory(params.memory, fn(room) {
////       Room(messages: [params.args, ..room.messages])
////     })
////   promise.resolve(list.length(room.messages))
//// }
////
//// pub fn recent(params: Params(Int, Room)) -> Promise(List(String)) {
////   durable_object.read_memory(params.memory).messages
////   |> list.take(params.args)
////   |> promise.resolve
//// }
//// ```
////
//// A Worker calls the methods of an instance through a stub:
////
//// ```gleam
//// // src/app.gleam
//// import app/chat_room
//// import gleam/int
//// import gleam/javascript/promise.{type Promise}
//// import rays/durable_object
//// import rays/worker.{type Context, type Env, type Request, type Response}
////
//// pub fn handle_request(
////   _request: Request,
////   _env: Env,
////   ctx: Context,
//// ) -> Promise(Response) {
////   case durable_object.exported(ctx, chat_room.chat_room) {
////     Ok(rooms) -> {
////       let room = durable_object.get_by_name(rooms, "general")
////       let posted = durable_object.call(room, chat_room.post, "Hello!")
////       use posted <- promise.map(posted)
////       case posted {
////         Ok(count) -> worker.ok() |> worker.string_body(int.to_string(count))
////         Error(_) -> worker.response(502)
////       }
////     }
////     Error(Nil) -> promise.resolve(worker.internal_server_error())
////   }
//// }
//// ```
////
//// This code is compiled in rays's own test suite. The
//// `examples/durable_object` project runs a chat room in the Workers
//// runtime that keeps its messages in its database instead, with
//// `rays/durable_object/sql`.
////
//// ## Memory and interleaving
////
//// An instance runs one piece of code at a time, but while one call awaits
//// a promise, another call can run. So a value read with `read_memory`
//// before an `await` may be out of date after it. `update_memory` takes a
//// function that is not async, so nothing else can run while it does: it
//// always works on the memory as it is at that moment, and two calls that
//// update the memory never lose each other's changes.
////
//// When a call must have the instance to itself across an `await`, such as
//// to read the memory, fetch something, and write the memory from both,
//// it takes the instance's `lock`. Nothing else runs until it is released:
////
//// ```gleam
//// pub fn refresh(params: Params(Nil, Rates)) -> Promise(Float) {
////   use <- durable_object.lock(params.context)
////   let before = durable_object.read_memory(params.memory).latest
////   use fetched <- promise.map(fetch_rate(params.env))
////   // Nothing else ran during the fetch, so `before` is still current.
////   let latest = { before +. fetched } /. 2.0
////   durable_object.update_memory(params.memory, fn(_) { Rates(latest:) })
////   latest
//// }
//// ```
////
//// ## Waking
////
//// An instance wakes when it is first called, and again on the first call
//// after each eviction. Its memory starts as the value given to `new`, and
//// then the class's `on_wake` function, if it has one, runs before any
//// call. Work it does there that is async doesn't hold calls back, unless
//// it takes the lock:
////
//// ```gleam
//// pub fn rates() -> DurableObject(Rates) {
////   durable_object.new(Rates(latest: 1.0))
////   |> durable_object.on_wake(fn(wake) {
////     // Calls wait until the rate has been fetched.
////     let loading = {
////       use <- durable_object.lock(wake.context)
////       use latest <- promise.map(fetch_rate(wake.env))
////       durable_object.update_memory(wake.memory, fn(_) { Rates(latest:) })
////     }
////     durable_object.wait_until(wake.context, loading)
////   })
////   |> durable_object.bind(refresh)
//// }
//// ```
////
//// ## How it works
////
//// Every public function in the package that takes no arguments and
//// returns a `DurableObject` is a class, named after the function in
//// PascalCase, so `chat_room` is `ChatRoom`. That is the name the Cloudflare
//// configuration declares in the Worker's `exports`:
////
//// ```ts
//// // cloudflare.config.ts
//// worker: raysWorker({
////   name: "my-app",
////   compatibilityDate: "2026-09-01",
////   exports: { ChatRoom: exports.durableObject({ storage: "sqlite" }) },
//// }),
//// ```
////
//// A Worker's entry module exports only the classes its `exports` declare,
//// and the build fails if one isn't in the package. A class's name is the
//// identity of its stored data, so renaming or removing its function also
//// means keeping the old name in `exports`, with `state: "renamed"` or
//// `state: "deleted"`. With a Wrangler config file, `rays build` and the
//// `rays()` Vite plugin export every class from every Worker's entry module.
////
//// Methods work like `rays/worker_rpc`'s: a method is a public function in
//// the package whose only argument is a `durable_object.Params`, and it
//// returns a `Promise`. Its arguments and reply are encoded the same way,
//// and calls fail with a `CallError` that holds the same
//// `worker_rpc.CallError`, or says how the instance failed. Every class has
//// an entry for every method, and serves the ones bound to it.

import gleam/dynamic.{type Dynamic}
import gleam/javascript/promise.{type Promise}
import gleam/result
import rays/worker.{type Env}
import rays/worker_rpc

//
// Defining a Durable Object class
//

/// A Durable Object class whose instances hold memory of type `memory`,
/// made with `new`.
///
/// The build exports a class for every public function in the package that
/// takes no arguments and returns a `DurableObject`, named after the
/// function in PascalCase. Its memory type must be concrete, so a generic
/// class fails the build, as do two functions with the same class name.
///
pub type DurableObject(memory)

/// An instance's `DurableObjectState`: its id, and `wait_until`.
///
pub type Context

/// A handle on the memory of a running instance, read with `read_memory`
/// and changed with `update_memory`. It can't be sent to another Worker.
///
pub type Memory(memory)

/// Create a Durable Object class whose instances start with the given
/// memory, each time they wake.
///
/// # Examples
///
/// ```gleam
/// pub fn counter() -> DurableObject(Int) {
///   durable_object.new(0)
///   |> durable_object.bind(increment)
/// }
/// ```
///
@external(javascript, "./durable_object_ffi.mts", "newObject")
pub fn new(memory: memory) -> DurableObject(memory)

/// What an `on_wake` function receives: the Worker's bindings, the
/// instance's context, and a handle on its memory.
///
pub type Wake(memory) {
  Wake(env: Env, context: Context, memory: Memory(memory))
}

/// Run a function each time an instance wakes, after its memory is set to
/// the value given to `new` and before any call is delivered. A class has
/// one: a later `on_wake` replaces an earlier one.
///
/// The function isn't async, so whatever it does synchronously, such as
/// `update_memory`, is done before the first call. Async work it starts
/// runs alongside calls, unless it takes the instance's `lock`, which holds
/// them back until the work is done. Pass the work's promise to
/// `wait_until`, so the instance isn't evicted before it finishes.
///
/// If the function panics, the instance isn't created, and the call that
/// woke it fails with `RpcFailed(SendFailed(..))`. If locked work it started fails, the
/// instance is reset, and the calls waiting on it fail with `Reset`. Either
/// way, the next call wakes the instance again.
///
/// # Examples
///
/// ```gleam
/// durable_object.new(Room(name: "", messages: []))
/// |> durable_object.on_wake(fn(wake) {
///   let name = durable_object.id(wake.context) |> durable_object.id_name
///   let name = result.unwrap(name, "unnamed")
///   durable_object.update_memory(wake.memory, fn(room) { Room(..room, name:) })
///   Nil
/// })
/// ```
///
pub fn on_wake(
  object: DurableObject(memory),
  wake: fn(Wake(memory)) -> Nil,
) -> DurableObject(memory) {
  js_on_wake(object, fn(env, context, memory) {
    wake(Wake(env:, context:, memory:))
  })
}

/// What an RPC method receives: the caller's argument, the Worker's
/// bindings, the instance's context, and a handle on its memory.
///
/// Several values go in a record or a tuple, and `Nil` stands for none.
///
pub type Params(args, memory) {
  Params(args: args, env: Env, context: Context, memory: Memory(memory))
}

/// Serve an RPC method from this class. The method's memory type must be
/// the class's own.
///
/// The method is a public function in this package whose only argument is a
/// `Params`, or the Worker fails to start when it is built with rays.
///
/// The reply is sent back to the caller. If the method panics, or its
/// promise rejects, the caller gets `RpcFailed(HandlerFailed(..))` instead.
/// Errors the caller should handle belong in the reply type.
///
pub fn bind(
  object: DurableObject(memory),
  method: fn(Params(args, memory)) -> Promise(reply),
) -> DurableObject(memory) {
  js_bind(object, method, fn(args, env, context, memory) {
    method(Params(args:, env:, context:, memory:))
  })
}

//
// Memory
//

/// Update the memory with the given function, and return the new memory.
///
/// The function is not async, so nothing else runs while it does: it always
/// works on the memory as it is now, even if other calls changed it while
/// this one was awaiting something.
///
/// If the function panics, the memory is left as it was, and the panic
/// carries on up the method, so its caller gets
/// `RpcFailed(HandlerFailed(..))`.
///
/// # Examples
///
/// ```gleam
/// pub fn increment(params: Params(Int, Int)) -> Promise(Int) {
///   durable_object.update_memory(params.memory, fn(count) {
///     count + params.args
///   })
///   |> promise.resolve
/// }
/// ```
///
@external(javascript, "./durable_object_ffi.mts", "updateMemory")
pub fn update_memory(
  memory: Memory(memory),
  with update: fn(memory) -> memory,
) -> memory

/// The memory as it is now.
///
/// After an `await`, other calls may have changed the memory, so read it
/// again rather than keep using this value, and change the memory with
/// `update_memory` rather than from a value read before.
///
@external(javascript, "./durable_object_ffi.mts", "readMemory")
pub fn read_memory(memory: Memory(memory)) -> memory

//
// Context
//

/// The id of this instance.
///
@external(javascript, "./durable_object_ffi.mts", "contextId")
pub fn id(context: Context) -> Id

/// Keep the instance from being evicted until the promise settles, for up
/// to 15 minutes, without delaying the reply.
///
@external(javascript, "./durable_object_ffi.mts", "waitUntil")
pub fn wait_until(context: Context, promise: Promise(a)) -> Nil

/// Take the instance's lock while the function's promise is pending. No
/// other call, and no other event such as the reply to another call's
/// fetch, is delivered to the instance until it resolves. The function's
/// own work, including what it awaits, carries on as usual.
///
/// This is Cloudflare's `blockConcurrencyWhile`. Unlike a mutex, it holds
/// back everything, not just other calls that take the lock, so keep what
/// it does short: at 5ms a call, an instance can serve about 200 calls a
/// second. `update_memory` is enough to change the memory safely; the lock
/// is for when a call reads the memory, awaits something, and then writes
/// it from what it read.
///
/// The lock is released when the promise resolves, so there is no unlock:
/// code after the promise, rather than inside the function, runs
/// unlocked. A lock can be taken inside another.
///
/// If the function panics, its promise rejects, or it takes longer than 30
/// seconds, the instance is reset: its memory is lost, and every call
/// waiting on it fails with `Reset`.
///
/// # Examples
///
/// The rest of the method holds the lock:
///
/// ```gleam
/// pub fn refresh(params: Params(Nil, Rates)) -> Promise(Float) {
///   use <- durable_object.lock(params.context)
///   let before = durable_object.read_memory(params.memory).latest
///   use fetched <- promise.map(fetch_rate(params.env))
///   // Nothing else ran during the fetch, so `before` is still current.
///   let latest = { before +. fetched } /. 2.0
///   durable_object.update_memory(params.memory, fn(_) { Rates(latest:) })
///   latest
/// }
/// ```
///
/// Only the first step holds the lock:
///
/// ```gleam
/// use latest <- promise.await(
///   durable_object.lock(params.context, fn() { fetch_and_store(params) }),
/// )
/// // Unlocked: other calls run while this one logs.
/// use _ <- promise.map(log_rate(params.env, latest))
/// latest
/// ```
///
@external(javascript, "./durable_object_ffi.mts", "lock")
pub fn lock(context: Context, locked: fn() -> Promise(a)) -> Promise(a)

//
// Ids
//

/// The id of one instance of a Durable Object class.
///
pub type Id

/// Make a new, random id. Its instance is created the first time it is
/// called, without the worldwide check a named instance needs, so that
/// first call is faster. Keep `id_to_string` of it to reach the same
/// instance again.
///
@external(javascript, "./durable_object_ffi.mts", "newUniqueId")
pub fn new_unique_id(namespace: Namespace(memory)) -> Id

/// The id of the instance with the given name. The same name always gives
/// the same id in a namespace, and a different one in each jurisdiction.
///
@external(javascript, "./durable_object_ffi.mts", "idFromName")
pub fn id_from_name(namespace: Namespace(memory), name: String) -> Id

/// Parse an id made by `id_to_string`.
///
/// Returns an error if the string isn't an id of this namespace.
///
@external(javascript, "./durable_object_ffi.mts", "idFromString")
pub fn id_from_string(
  namespace: Namespace(memory),
  id: String,
) -> Result(Id, Nil)

/// The id as a string of 64 hex digits.
///
@external(javascript, "./durable_object_ffi.mts", "idToString")
pub fn id_to_string(id: Id) -> String

/// The name the id was made from, by `id_from_name` or `get_by_name`.
///
/// Returns an error for an id made by `new_unique_id` or `id_from_string`,
/// and, inside an instance, for a name longer than 1,024 bytes.
///
@external(javascript, "./durable_object_ffi.mts", "idName")
pub fn id_name(id: Id) -> Result(String, Nil)

//
// Calling a Durable Object
//

/// A namespace: every instance of one Durable Object class with memory
/// `memory`.
///
/// It also holds a jurisdiction and a location hint, which apply to the
/// ids and stubs made from it.
///
pub type Namespace(memory)

/// A client for one instance of a Durable Object class.
///
/// A stub can be kept and called again after a call fails. Some failures,
/// such as a `Reset`, break the runtime's own stub, so that every later call
/// through it fails the same way; when that happens, the next `call` makes a
/// new one. Calls sent after that have no ordering guarantee relative to the
/// ones that failed.
///
pub type Stub(memory)

/// Get the namespace bound to the given name, through a Durable Object
/// binding.
///
/// Returns an error if there is no binding with that name. Whether the
/// binding really is a namespace of this class is only known when a method
/// is called: if it isn't, calls fail with `RpcFailed(NotBound(..))`.
///
/// # Examples
///
/// ```gleam
/// case durable_object.namespace(env, "ROOMS") {
///   Ok(rooms) -> todo
///   Error(Nil) -> worker.internal_server_error() |> promise.resolve
/// }
/// ```
///
pub fn namespace(env: Env, name: String) -> Result(Namespace(memory), Nil) {
  worker.env_binding(env, name)
  |> result.try(js_namespace)
}

/// Get the namespace of a class that this Worker exports, through
/// `ctx.exports`, without a binding.
///
/// The class is given as the function that defines it, so the namespace has
/// its memory type.
///
/// Returns an error if this Worker doesn't export the class, as when one
/// project builds several Workers and the class is declared in another's
/// configuration.
///
/// # Examples
///
/// ```gleam
/// case durable_object.exported(ctx, chat_room.chat_room) {
///   Ok(rooms) -> durable_object.get_by_name(rooms, "general")
///   Error(Nil) -> todo
/// }
/// ```
///
@external(javascript, "./durable_object_ffi.mts", "exported")
pub fn exported(
  ctx: worker.Context,
  class: fn() -> DurableObject(memory),
) -> Result(Namespace(memory), Nil)

/// Where the data of a namespace's instances is allowed to live.
///
pub type Jurisdiction {
  /// The European Union.
  Eu
  /// The United States.
  Us
  /// FedRAMP-Moderate data centers.
  Fedramp
}

/// Restrict the namespace to a jurisdiction: its instances run and store
/// their data only there. The same name is a different instance in each
/// jurisdiction.
///
pub fn jurisdiction(
  namespace: Namespace(memory),
  jurisdiction: Jurisdiction,
) -> Namespace(memory) {
  js_jurisdiction(namespace, case jurisdiction {
    Eu -> "eu"
    Us -> "us"
    Fedramp -> "fedramp"
  })
}

/// Where to create an instance that doesn't exist yet.
///
pub type LocationHint {
  WesternNorthAmerica
  EasternNorthAmerica
  SouthAmerica
  WesternEurope
  EasternEurope
  AsiaPacific
  NortheastAsiaPacific
  SoutheastAsiaPacific
  Oceania
  Africa
  MiddleEast
}

/// Hint where the stubs made from the namespace should create their
/// instances. It is only a hint, and has no effect on an instance that
/// already exists. Without one, an instance is created near the Worker
/// that first calls it, which is usually best.
///
pub fn location_hint(
  namespace: Namespace(memory),
  hint: LocationHint,
) -> Namespace(memory) {
  js_location_hint(namespace, case hint {
    WesternNorthAmerica -> "wnam"
    EasternNorthAmerica -> "enam"
    SouthAmerica -> "sam"
    WesternEurope -> "weur"
    EasternEurope -> "eeur"
    AsiaPacific -> "apac"
    NortheastAsiaPacific -> "apac-ne"
    SoutheastAsiaPacific -> "apac-se"
    Oceania -> "oc"
    Africa -> "afr"
    MiddleEast -> "me"
  })
}

/// Get the instance with the given name, which is created when it is first
/// called. The same as `get` with `id_from_name`.
///
@external(javascript, "./durable_object_ffi.mts", "getByName")
pub fn get_by_name(namespace: Namespace(memory), name: String) -> Stub(memory)

/// Get the instance with the given id, which is created when it is first
/// called.
///
@external(javascript, "./durable_object_ffi.mts", "get")
pub fn get(namespace: Namespace(memory), id: Id) -> Stub(memory)

/// Call an RPC method on an instance.
///
/// Pass the method's function itself. Its argument, reply and memory types
/// are checked when the Worker is compiled.
///
/// The outer `Result` says whether the call happened. Errors the method
/// itself returns are part of its reply type.
///
/// # Examples
///
/// ```gleam
/// let room = durable_object.get_by_name(rooms, "general")
/// use posted <- promise.await(durable_object.call(room, chat_room.post, "Hi"))
/// case posted {
///   Ok(_) -> worker.ok() |> promise.resolve
///   Error(_) -> worker.response(502) |> promise.resolve
/// }
/// ```
///
pub fn call(
  stub: Stub(memory),
  method: fn(Params(args, memory)) -> Promise(reply),
  args: args,
) -> Promise(Result(reply, CallError)) {
  use outcome <- promise.map(js_call(stub, method, args))
  result.map_error(outcome, failure_to_call_error)
}

/// An error that can occur when calling a method on a Durable Object.
///
pub type CallError {
  /// The call failed the way a Workers RPC call can, such as because the
  /// instance doesn't bind the method, or the method panicked.
  RpcFailed(reason: worker_rpc.CallError)
  /// The instance was reset while the call waited, so its memory is gone.
  /// That happens when work holding its `lock` panics, rejects, or takes
  /// longer than 30 seconds. The next call, through the same stub or a new
  /// one, wakes the instance again.
  Reset(method: String, message: String)
  /// The instance has too many requests queued. Retrying adds to its load,
  /// so back off or give up.
  Overloaded(method: String)
  /// The call failed in a way that is safe to retry, such as the instance
  /// being moved.
  Retryable(method: String, message: String)
}

/// Turn a failure reported by the FFI's `call` into a `CallError`. A Durable
/// Object's own failures are checked first; the rest are the ones Workers
/// RPC has.
///
@internal
pub fn failure_to_call_error(failure: #(String, String, String)) -> CallError {
  case failure {
    #("reset", method, message) -> Reset(method:, message:)
    #("overloaded", method, _) -> Overloaded(method:)
    #("retryable", method, message) -> Retryable(method:, message:)
    _ -> RpcFailed(worker_rpc.failure_to_call_error(failure))
  }
}

@external(javascript, "./durable_object_ffi.mts", "onWake")
fn js_on_wake(
  object: DurableObject(memory),
  wake: fn(Env, Context, Memory(memory)) -> Nil,
) -> DurableObject(memory)

@external(javascript, "./durable_object_ffi.mts", "bind")
fn js_bind(
  object: DurableObject(memory),
  method: fn(Params(args, memory)) -> Promise(reply),
  handler: fn(args, Env, Context, Memory(memory)) -> Promise(reply),
) -> DurableObject(memory)

@external(javascript, "./durable_object_ffi.mts", "namespace")
fn js_namespace(binding: Dynamic) -> Result(Namespace(memory), Nil)

@external(javascript, "./durable_object_ffi.mts", "jurisdiction")
fn js_jurisdiction(
  namespace: Namespace(memory),
  jurisdiction: String,
) -> Namespace(memory)

@external(javascript, "./durable_object_ffi.mts", "locationHint")
fn js_location_hint(
  namespace: Namespace(memory),
  hint: String,
) -> Namespace(memory)

@external(javascript, "./durable_object_ffi.mts", "call")
fn js_call(
  stub: Stub(memory),
  method: fn(Params(args, memory)) -> Promise(reply),
  args: args,
) -> Promise(Result(reply, #(String, String, String)))
