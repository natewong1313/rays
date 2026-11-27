//// Tests for `rays/worker_rpc` through `simulate.with_rpc_service`, which
//// calls bound handlers directly. Encoding, versions and the generated entry
//// module are tested with a real build in `packages/core`.

import gleam/http
import gleam/javascript/promise.{type Promise}
import gleam/option.{type Option, None, Some}
import rays/app
import rays/worker
import rays/worker/simulate
import rays/worker_rpc
import rays/worker_rpc_example/app as example_app
import rays/worker_rpc_example/names as example_names

pub type User {
  User(id: Int, name: String)
}

pub type Search {
  Search(query: String, limit: Int)
}

pub fn find_user(params: worker_rpc.Params(Int)) -> Promise(Option(User)) {
  let name = case worker.env_var(params.env, "PREFIX") {
    Ok(prefix) -> prefix <> "Ada"
    Error(Nil) -> "Ada"
  }
  promise.resolve(case params.args {
    1 -> Some(User(id: 1, name:))
    _ -> None
  })
}

pub fn search(params: worker_rpc.Params(Search)) -> Promise(List(String)) {
  let Search(query:, limit:) = params.args
  promise.resolve(case limit {
    0 -> []
    _ -> [query, query <> "2"]
  })
}

pub fn pair(params: worker_rpc.Params(#(Int, Int))) -> Promise(Int) {
  let #(a, b) = params.args
  promise.resolve(a + b)
}

pub fn crash(_params: worker_rpc.Params(Nil)) -> Promise(Nil) {
  panic as "the handler crashed"
}

fn worker() -> worker.Worker {
  worker.new(fn(_request, _env, _ctx) { promise.resolve(worker.ok()) })
  |> worker_rpc.bind(find_user)
  |> worker_rpc.bind(search)
  |> worker_rpc.bind(pair)
  |> worker_rpc.bind(crash)
}

fn names() -> worker_rpc.Service {
  let worker_env = simulate.env() |> simulate.env_var("PREFIX", "Dr ")
  let env =
    simulate.env()
    |> simulate.with_rpc_service(
      "NAMES",
      simulate.context(),
      worker(),
      worker_env,
    )
  let assert Ok(service) = worker_rpc.service(env, "NAMES")
  service
}

pub fn call_test() -> Promise(Nil) {
  use found <- promise.await(worker_rpc.call(names(), find_user, 1))
  assert found == Ok(Some(User(id: 1, name: "Dr Ada")))
  use missing <- promise.map(worker_rpc.call(names(), find_user, 2))
  assert missing == Ok(None)
}

pub fn call_with_record_test() -> Promise(Nil) {
  use found <- promise.map(worker_rpc.call(
    names(),
    search,
    Search(query: "ada", limit: 5),
  ))
  assert found == Ok(["ada", "ada2"])
}

pub fn call_with_tuple_test() -> Promise(Nil) {
  use sum <- promise.map(worker_rpc.call(names(), pair, #(2, 3)))
  assert sum == Ok(5)
}

pub fn method_called_directly_test() -> Promise(Nil) {
  let params =
    worker_rpc.Params(args: 1, env: simulate.env(), context: simulate.context())
  use found <- promise.map(find_user(params))
  assert found == Some(User(id: 1, name: "Ada"))
}

pub fn call_unbound_method_test() -> Promise(Nil) {
  let env =
    simulate.env()
    |> simulate.with_rpc_service(
      "EMPTY",
      simulate.context(),
      worker.new(fn(_, _, _) { promise.resolve(worker.ok()) }),
      simulate.env(),
    )
  let assert Ok(service) = worker_rpc.service(env, "EMPTY")
  use result <- promise.map(worker_rpc.call(
    service,
    search,
    Search(query: "ada", limit: 1),
  ))
  assert result == Error(worker_rpc.NotBound(method: "search"))
}

pub fn call_crashing_handler_test() -> Promise(Nil) {
  use result <- promise.map(worker_rpc.call(names(), crash, Nil))
  let assert Error(worker_rpc.HandlerFailed(method: "crash", message:)) = result
  assert message == "the handler crashed"
}

pub fn missing_service_test() {
  assert worker_rpc.service(simulate.env(), "NAMES") == Error(Nil)
}

pub fn module_docs_example_test() -> Promise(Nil) {
  let ctx = simulate.context()
  let front =
    app.Worker("front", entrypoint: fn() {
      worker.new(example_app.handle_request)
    })
  app.new("example", main: front)
  |> app.register_worker(example_names.worker)
  |> app.simulate(context: ctx)
  let request = simulate.request(http.Get, "/")
  use response <- promise.map(example_app.handle_request(
    request,
    simulate.env(),
    ctx,
  ))
  assert response.status == 200
  assert simulate.read_body(response) == "Ada, Adam"
}
