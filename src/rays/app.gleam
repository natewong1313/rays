//// Declare the Workers and Durable Object classes of a rays app in Gleam,
//// and reach them from each other without knowing their binding names.
////
//// **Proof of concept.** The API and the names it derives may change.
////
//// Each Worker module declares its Worker as a constant, beside the
//// `main` function that builds it:
////
//// ```gleam
//// // src/shop/inventory.gleam
//// import rays/app
//// import rays/worker
////
//// pub const worker = app.Worker("inventory", entrypoint: main)
////
//// pub fn main() -> worker.Worker {
////   worker.new(handle_request)
////   |> worker_rpc.bind(stock)
//// }
//// ```
////
//// A Durable Object class needs no constant: the function that defines it
//// is its handle, and carries its memory type.
////
//// The **app** module's `pub fn app() -> App` registers them all, and says
//// which Worker hosts each class. Nothing imports it: the build reads it to
//// make the Cloudflare configuration.
////
//// ```gleam
//// // src/shop.gleam
//// import rays/app.{type App}
//// import shop/cart
//// import shop/inventory
//// import shop/storefront
////
//// pub fn app() -> App {
////   app.new("shop", main: storefront.worker)
////   |> app.register_worker(inventory.worker)
////   |> app.register_durable_object(cart.cart, hosted_by: storefront.worker)
//// }
//// ```
////
//// A Worker then reaches another through its constant, and a Durable Object
//// class through its function. Calling another Worker's methods means
//// importing its module anyway, so the constant is already in reach:
////
//// ```gleam
//// // src/shop/storefront.gleam
//// app.connect_worker(inventory.worker)
//// |> worker_rpc.call(inventory.stock, sku)
////
//// case app.connect_durable_object(cart.cart) {
////   Ok(carts) -> durable_object.get_by_name(carts, user_id)
////   Error(Nil) -> todo
//// }
//// ```
////
//// A misspelt Worker is a compile error, not a missing binding at runtime,
//// and a Durable Object namespace has the memory type of its class.
//// Neither needs the Worker's `env`: rays keeps the one the runtime gives
//// it, which is the same for every request, RPC call and Durable Object of
//// the Worker.
////
//// ## How it works
////
//// The binding names are derived, the same way on both sides, from what the
//// code already holds: a Worker's name, or a class's name. `raysApp()` in
//// `@rays/config/app` calls `app()` when the configuration is loaded and
//// gives every Worker of the app a binding to every other Worker except the
//// main one, which is the app's front door, and to every Durable Object
//// class, under those names. Nothing is generated.
////
//// | Resource                                 | Binding         |
//// | ---------------------------------------- | --------------- |
//// | `app.Worker("inventory", ..)`            | `INVENTORY`     |
//// | `app.Worker("order-history", ..)`        | `ORDER_HISTORY` |
//// | `pub fn shopping_cart()`                 | `SHOPPING_CART` |

import gleam/dict
import gleam/list
import gleam/result
import gleam/string
import rays/durable_object.{type DurableObject, type Namespace}
import rays/worker.{type Env}
import rays/worker_rpc

//
// Workers
//

/// A Worker of the app: its name within the app, and its entrypoint, the
/// function that builds it. Declare one as a constant in the Worker's own
/// module, conventionally named `worker`, and pass it around instead of a
/// binding name.
///
/// The name is lowercase letters, digits and hyphens, starting with a
/// letter. The app's main Worker is deployed under the app's name, and the
/// others under `<app name>-<name>`.
///
pub type Worker {
  Worker(name: String, entrypoint: fn() -> worker.Worker)
}

//
// The app
//

/// The Workers and Durable Object classes of an app, made with `new`.
pub opaque type App {
  App(name: String, main: Worker, workers: List(Worker), classes: List(Hosted))
}

/// A Durable Object class, by its class name, and the Worker that exports
/// it.
type Hosted {
  Hosted(class_name: String, host: Worker)
}

/// Start an app with its main Worker: the one that receives the app's
/// requests, deployed under the app's name. The app's other Workers don't
/// get a binding to it.
///
pub fn new(name: String, main main: Worker) -> App {
  App(name:, main:, workers: [main], classes: [])
}

/// Add a Worker to the app. Every Worker of the app can reach it with
/// `connect_worker`.
///
pub fn register_worker(app: App, worker: Worker) -> App {
  App(..app, workers: [worker, ..app.workers])
}

/// Add a Durable Object class to the app, hosted by one of its Workers.
///
/// Cloudflare has two relationships between a class and Workers. Exactly
/// one Worker **hosts** the class: it exports it, and owns its instances
/// and their storage. Any number of Workers **bind** to it, to call its
/// instances. `hosted_by` names the host; every Worker of the app, the host
/// included, is bound to the class, so any of them, and any Durable Object,
/// can reach it with `connect_durable_object`.
///
/// Choose the host with care: moving a class to another Worker later is a
/// transfer of its stored data, which Cloudflare makes in two deploys.
///
/// The class keeps the name the build gives it, from its function, so
/// `pub fn chat_room()` is `ChatRoom`.
///
pub fn register_durable_object(
  app: App,
  class: fn() -> DurableObject(memory),
  hosted_by host: Worker,
) -> App {
  let hosted = Hosted(class_name: class_name(class), host:)
  App(..app, classes: [hosted, ..app.classes])
}

/// The app's name.
pub fn name(app: App) -> String {
  app.name
}

//
// Checking an app
//

/// A mistake in how an app is put together, found by `validate`.
pub type AppError {
  /// The app's name, or a Worker's, isn't lowercase letters, digits and
  /// hyphens starting with a letter, as a Worker's name must be.
  InvalidName(name: String)
  /// The app adds two Workers with the same name.
  DuplicateWorker(name: String)
  /// The app adds the same Durable Object class twice.
  DuplicateClass(class_name: String)
  /// A Durable Object class is hosted by a Worker the app doesn't add.
  UnknownHost(class_name: String, host: String)
  /// Two resources of the app would have the same binding name.
  BindingClash(binding: String, first: String, second: String)
}

/// Check that the app's names are usable and don't clash, returning every
/// mistake found. `raysApp()` checks the app with this before it makes any
/// configuration.
///
pub fn validate(app: App) -> Result(Nil, List(AppError)) {
  let workers = list.reverse(app.workers)
  let classes = list.reverse(app.classes)
  let worker_names = list.map(workers, fn(worker) { worker.name })

  let invalid =
    [app.name, ..worker_names]
    |> list.filter(fn(name) { !is_valid_name(name) })
    |> list.map(InvalidName)

  let duplicate_workers = duplicates(worker_names) |> list.map(DuplicateWorker)

  let duplicate_classes =
    classes
    |> list.map(fn(hosted) { hosted.class_name })
    |> duplicates
    |> list.map(DuplicateClass)

  let unknown_hosts =
    classes
    |> list.filter(fn(hosted) { !list.contains(worker_names, hosted.host.name) })
    |> list.map(fn(hosted) {
      UnknownHost(class_name: hosted.class_name, host: hosted.host.name)
    })

  let clashes =
    list.append(
      list.map(workers, fn(worker) {
        #(service_binding(worker), "Worker " <> worker.name)
      }),
      list.map(classes, fn(hosted) {
        #(class_binding(hosted.class_name), "class " <> hosted.class_name)
      }),
    )
    |> binding_clashes

  case
    list.flatten([
      invalid,
      duplicate_workers,
      duplicate_classes,
      unknown_hosts,
      clashes,
    ])
  {
    [] -> Ok(Nil)
    errors -> Error(errors)
  }
}

/// A sentence describing the mistake, for the build to report.
pub fn describe_error(error: AppError) -> String {
  case error {
    InvalidName(name:) ->
      "\""
      <> name
      <> "\" can't name a Worker: use lowercase letters, digits and hyphens, starting with a letter."
    DuplicateWorker(name:) ->
      "The app adds the Worker \"" <> name <> "\" more than once."
    DuplicateClass(class_name:) ->
      "The app adds the Durable Object class "
      <> class_name
      <> " more than once."
    UnknownHost(class_name:, host:) ->
      "The Durable Object class "
      <> class_name
      <> " is hosted by the Worker \""
      <> host
      <> "\", which the app doesn't register with app.register_worker."
    BindingClash(binding:, first:, second:) ->
      "The "
      <> first
      <> " and the "
      <> second
      <> " would both be bound as "
      <> binding
      <> ". Rename one of them."
  }
}

fn is_valid_name(name: String) -> Bool {
  case string.to_graphemes(name) {
    [first, ..rest] ->
      is_lowercase_letter(first)
      && list.all(rest, fn(grapheme) {
        is_lowercase_letter(grapheme) || is_digit(grapheme) || grapheme == "-"
      })
    [] -> False
  }
}

fn is_lowercase_letter(grapheme: String) -> Bool {
  string.contains("abcdefghijklmnopqrstuvwxyz", grapheme)
}

fn is_digit(grapheme: String) -> Bool {
  string.contains("0123456789", grapheme)
}

/// The values that appear more than once, each once, in order of their
/// second appearance.
fn duplicates(values: List(String)) -> List(String) {
  let #(_, found) =
    list.fold(values, #([], []), fn(acc, value) {
      let #(seen, found) = acc
      case list.contains(seen, value), list.contains(found, value) {
        True, True -> acc
        True, False -> #(seen, [value, ..found])
        False, _ -> #([value, ..seen], found)
      }
    })
  list.reverse(found)
}

fn binding_clashes(bindings: List(#(String, String))) -> List(AppError) {
  let #(_, clashes) =
    list.fold(bindings, #(dict.new(), []), fn(acc, binding) {
      let #(seen, clashes) = acc
      let #(name, owner) = binding
      case dict.get(seen, name) {
        Ok(first) -> #(seen, [
          BindingClash(binding: name, first:, second: owner),
          ..clashes
        ])
        Error(Nil) -> #(dict.insert(seen, name, owner), clashes)
      }
    })
  list.reverse(clashes)
}

//
// Reaching the app's resources
//

/// Connect to another Worker of the app, to call its RPC methods with
/// `worker_rpc.call`.
///
/// This always succeeds: the binding is looked up in the Worker's env when a
/// method is called. If the Worker has no binding to it, as when its
/// configuration doesn't come from `raysApp()`, or a test didn't set up the
/// app with `simulate`, the call fails with `worker_rpc.NotConfigured`.
///
/// # Examples
///
/// ```gleam
/// app.connect_worker(names.worker)
/// |> worker_rpc.call(names.find_visitor, Nil)
/// ```
///
pub fn connect_worker(worker: Worker) -> worker_rpc.Service {
  js_bound_service(service_binding(worker))
}

@external(javascript, "./worker_rpc_ffi.mts", "boundService")
fn js_bound_service(binding: String) -> worker_rpc.Service

/// Connect to a Durable Object class of the app, from any of its Workers or
/// Durable Objects, whichever Worker hosts it.
///
/// This gives the class's namespace, all of its instances. Choose one with
/// `durable_object.get_by_name` or `durable_object.get`, then call its
/// methods with `durable_object.call`.
///
/// Returns an error if the Worker has no binding to the class, as when the
/// app doesn't register it with `register_durable_object`. Unlike
/// `connect_worker`, this can't wait until a call, since ids and stubs are
/// made from the namespace straight away.
///
/// # Examples
///
/// ```gleam
/// case app.connect_durable_object(visit_counter.visit_counter) {
///   Ok(counters) -> durable_object.get_by_name(counters, "everyone")
///   Error(Nil) -> todo
/// }
/// ```
///
pub fn connect_durable_object(
  class: fn() -> DurableObject(memory),
) -> Result(Namespace(memory), Nil) {
  use env <- result.try(js_current_env())
  durable_object.namespace(env, class_binding(class_name(class)))
}

/// The env rays saw last: the Worker's own, in the Workers runtime.
@external(javascript, "./app_ffi.mts", "currentEnv")
fn js_current_env() -> Result(Env, Nil)

// The binding name of a Worker of the app: its name in uppercase, with
// hyphens as underscores, so `"order-history"` is `ORDER_HISTORY`.
fn service_binding(worker: Worker) -> String {
  worker.name |> string.uppercase |> string.replace("-", "_")
}

// The binding name of a Durable Object class: its class name in uppercase
// snake case, so `ChatRoom` is `CHAT_ROOM`.
fn class_binding(class_name: String) -> String {
  class_name
  |> string.to_graphemes
  |> list.index_map(fn(grapheme, index) {
    case index > 0 && grapheme != string.lowercase(grapheme) {
      True -> "_" <> grapheme
      False -> grapheme
    }
  })
  |> string.concat
  |> string.uppercase
}

/// The class name the build gives the class defined by the function. A
/// compiled build registers it; without one, as under `gleam test`, it is
/// worked out from the function's name the same way.
///
@external(javascript, "./app_ffi.mts", "className")
fn class_name(class: fn() -> DurableObject(memory)) -> String

//
// Simulating an app
//

/// Set up the app for `gleam test`, so that `connect_worker` reaches every
/// Worker of the app but the main one, as it does when deployed. Each is
/// built by its entrypoint and given an empty env of its own. Call it at the
/// start of each test that needs it.
///
/// The Workers of a test all run in one JavaScript runtime, so they share
/// this setup: a simulated Worker can also reach itself, which a deployed
/// one can't. Durable Object classes aren't simulated, so
/// `connect_durable_object` finds no binding.
///
/// # Examples
///
/// ```gleam
/// pub fn greets_the_visitor_test() {
///   app.simulate(greeter.app(), context: simulate.context())
///   front.handle_request(request, simulate.env(), simulate.context())
///   // ...
/// }
/// ```
///
pub fn simulate(app: App, context context: worker.Context) -> Nil {
  list.fold(app.workers, js_empty_env(), fn(env, worker) {
    case worker.name == app.main.name {
      True -> env
      False ->
        js_with_rpc_service(
          env,
          service_binding(worker),
          worker.entrypoint(),
          js_empty_env(),
          context,
        )
    }
  })
  |> js_use_env
}

@external(javascript, "./worker_ffi.mts", "useEnv")
fn js_use_env(env: Env) -> Nil

@external(javascript, "./worker/simulate_ffi.mts", "envWithRpcService")
fn js_with_rpc_service(
  env: Env,
  name: String,
  worker: worker.Worker,
  worker_env: Env,
  context: worker.Context,
) -> Env

@external(javascript, "./worker/simulate_ffi.mts", "emptyEnv")
fn js_empty_env() -> Env

//
// For the build
//

/// The app as plain data, for `raysApp()` to make the Cloudflare
/// configuration from. Not for use in Gleam code.
///
@internal
pub fn describe(app: App) -> Result(Description, List(String)) {
  use Nil <- result.map(
    validate(app) |> result.map_error(list.map(_, describe_error)),
  )
  Description(
    name: app.name,
    main: app.main.name,
    workers: list.reverse(app.workers)
      |> list.map(fn(worker) {
        #(worker.name, service_binding(worker), worker.entrypoint)
      }),
    classes: list.reverse(app.classes)
      |> list.map(fn(hosted) {
        #(hosted.class_name, class_binding(hosted.class_name), hosted.host.name)
      }),
  )
}

@internal
pub type Description {
  Description(
    name: String,
    main: String,
    /// Each Worker's name, binding name, and entrypoint.
    workers: List(#(String, String, fn() -> worker.Worker)),
    /// Each class's name, binding name, and the name of its host.
    classes: List(#(String, String, String)),
  )
}
