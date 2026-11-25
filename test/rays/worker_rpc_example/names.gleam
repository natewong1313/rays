//// The serving Worker from `rays/worker_rpc`'s module docs, compiled and
//// tested so the example stays correct.

import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/string
import rays/worker
import rays/worker_rpc

pub fn main() -> worker.Worker {
  worker.new(fn(_request, _env, _ctx) { promise.resolve(worker.not_found()) })
  |> worker_rpc.bind(search)
}

pub type Search {
  Search(query: String, limit: Int)
}

pub fn search(params: worker_rpc.Params(Search)) -> Promise(List(String)) {
  let Search(query:, limit:) = params.args
  ["Ada", "Adam", "Grace"]
  |> list.filter(string.starts_with(_, query))
  |> list.take(limit)
  |> promise.resolve
}
