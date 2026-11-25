//// The Worker the tests run in. It only exists to export the Durable
//// Object classes in `integration_tests/`: the tests call them directly.

import gleam/javascript/promise
import rays/worker

pub fn main() -> worker.Worker {
  worker.new(fn(_request, _env, _ctx) { promise.resolve(worker.not_found()) })
}
