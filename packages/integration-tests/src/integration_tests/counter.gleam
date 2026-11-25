//// A counter, whose methods show how calls to one instance interleave, and
//// what the instance's lock does about it.

import gleam/javascript/promise.{type Promise}
import rays/durable_object.{type DurableObject, type Params}

/// The `Counter` class.
pub fn counter() -> DurableObject(Int) {
  durable_object.new(0)
  |> durable_object.bind(add_slowly)
  |> durable_object.bind(add_from_read)
  |> durable_object.bind(add_locked)
  |> durable_object.bind(add_nested)
  |> durable_object.bind(read)
  |> durable_object.bind(crash)
  |> durable_object.bind(crash_locked)
  |> durable_object.bind(crash_locking)
}

/// Wait a moment, then add to the count. Other calls run during the wait,
/// but the update works on the count as it is after it, so none is lost.
pub fn add_slowly(params: Params(Int, Int)) -> Promise(Int) {
  use _ <- promise.map(promise.wait(20))
  durable_object.update_memory(params.memory, fn(count) { count + params.args })
}

/// Read the count, wait, and write what was read plus the amount. Calls
/// that run during the wait read the same count, so their additions are
/// lost: this is what `lock` is for.
pub fn add_from_read(params: Params(Int, Int)) -> Promise(Int) {
  let before = durable_object.read_memory(params.memory)
  use _ <- promise.map(promise.wait(20))
  durable_object.update_memory(params.memory, fn(_) { before + params.args })
}

/// `add_from_read` with the lock held, so no other call runs during the
/// wait and nothing is lost.
pub fn add_locked(params: Params(Int, Int)) -> Promise(Int) {
  use <- durable_object.lock(params.context)
  add_from_read(params)
}

/// `add_locked`, taking the lock again inside it.
pub fn add_nested(params: Params(Int, Int)) -> Promise(Int) {
  use <- durable_object.lock(params.context)
  use <- durable_object.lock(params.context)
  add_from_read(params)
}

pub fn read(params: Params(Nil, Int)) -> Promise(Int) {
  promise.resolve(durable_object.read_memory(params.memory))
}

/// Panic in the middle of an update, which leaves the count as it was.
pub fn crash(params: Params(Nil, Int)) -> Promise(Int) {
  durable_object.update_memory(params.memory, fn(_count) {
    panic as "the update crashed"
  })
  |> promise.resolve
}

/// Panic while holding the lock, which resets the instance.
pub fn crash_locked(params: Params(Nil, Int)) -> Promise(Int) {
  use <- durable_object.lock(params.context)
  use _ <- promise.map(promise.wait(5))
  panic as "the locked work crashed"
}

/// Panic in the locked function before it returns a promise, which resets
/// the instance too.
pub fn crash_locking(params: Params(Nil, Int)) -> Promise(Int) {
  use <- durable_object.lock(params.context)
  panic as "the lock crashed"
}
