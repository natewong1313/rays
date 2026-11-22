//// The serving Worker from `rays/workers_rpc`'s module docs, compiled and
//// tested so the example stays correct.

import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/string
import rays/workers
import rays/workers_rpc

pub fn main() -> workers.Worker {
  workers.new(fn(_request, _env, _ctx) { promise.resolve(workers.not_found()) })
  |> workers_rpc.bind(search)
}

pub type Search {
  Search(query: String, limit: Int)
}

pub fn search(params: workers_rpc.Params(Search)) -> Promise(List(String)) {
  let Search(query:, limit:) = params.args
  ["Ada", "Adam", "Grace"]
  |> list.filter(string.starts_with(_, query))
  |> list.take(limit)
  |> promise.resolve
}
