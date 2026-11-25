//// Classes whose instances do async work when they wake: `Sleepy` holds
//// calls back until it is done, with the lock, and `Restless` doesn't. The
//// `Sleepy` instance named "broken" can't wake at all.

import gleam/javascript/promise.{type Promise}
import gleam/result
import rays/durable_object.{type DurableObject, type Params, type Wake}

/// The `Sleepy` class. Its memory is the name it was woken with, once it
/// has finished waking.
pub fn sleepy() -> DurableObject(String) {
  durable_object.new("still waking")
  |> durable_object.on_wake(fn(wake) {
    case name(wake) {
      "broken" -> panic as "this instance can't wake"
      name -> {
        let waking = {
          use <- durable_object.lock(wake.context)
          finish_waking(wake, name)
        }
        durable_object.wait_until(wake.context, waking)
      }
    }
  })
  |> durable_object.bind(woken_as)
}

/// The `Restless` class: `Sleepy` without the lock, so calls can arrive
/// before it has finished waking.
pub fn restless() -> DurableObject(String) {
  durable_object.new("still waking")
  |> durable_object.on_wake(fn(wake) {
    durable_object.wait_until(wake.context, finish_waking(wake, name(wake)))
  })
  |> durable_object.bind(woken_as)
}

fn name(wake: Wake(String)) -> String {
  durable_object.id(wake.context)
  |> durable_object.id_name
  |> result.unwrap("no name")
}

fn finish_waking(wake: Wake(String), name: String) -> Promise(String) {
  use _ <- promise.map(promise.wait(20))
  durable_object.update_memory(wake.memory, fn(_) { name })
}

/// The name the instance was woken with, or "still waking".
pub fn woken_as(params: Params(Nil, String)) -> Promise(String) {
  promise.resolve(durable_object.read_memory(params.memory))
}
