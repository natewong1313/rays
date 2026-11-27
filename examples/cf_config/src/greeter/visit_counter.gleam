//// A Durable Object class that counts visits. The names Worker exports it,
//// and the main Worker calls it through the binding the app gives it.

import gleam/javascript/promise.{type Promise}
import rays/durable_object.{type DurableObject, type Params}

pub fn visit_counter() -> DurableObject(Int) {
  durable_object.new(0)
  |> durable_object.bind(record_visit)
}

/// Count a visit, replying with how many there have been.
pub fn record_visit(params: Params(Nil, Int)) -> Promise(Int) {
  durable_object.update_memory(params.memory, fn(count) { count + 1 })
  |> promise.resolve
}
