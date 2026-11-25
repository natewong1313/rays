//// The `rays/durable_object` module docs' examples of `lock` and
//// `on_wake`, compiled here so they keep compiling.

import gleam/javascript/promise.{type Promise}
import rays/durable_object.{type DurableObject, type Params}
import rays/worker.{type Env}

pub type Rates {
  Rates(latest: Float)
}

pub fn rates() -> DurableObject(Rates) {
  durable_object.new(Rates(latest: 1.0))
  |> durable_object.on_wake(fn(wake) {
    // Calls wait until the rate has been fetched.
    let loading = {
      use <- durable_object.lock(wake.context)
      use latest <- promise.map(fetch_rate(wake.env))
      durable_object.update_memory(wake.memory, fn(_) { Rates(latest:) })
    }
    durable_object.wait_until(wake.context, loading)
  })
  |> durable_object.bind(refresh)
}

pub fn refresh(params: Params(Nil, Rates)) -> Promise(Float) {
  use <- durable_object.lock(params.context)
  let before = durable_object.read_memory(params.memory).latest
  use fetched <- promise.map(fetch_rate(params.env))
  // Nothing else ran during the fetch, so `before` is still current.
  let latest = { before +. fetched } /. 2.0
  durable_object.update_memory(params.memory, fn(_) { Rates(latest:) })
  latest
}

fn fetch_rate(_env: Env) -> Promise(Float) {
  promise.resolve(1.5)
}
