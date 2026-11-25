//// The smallest rays Worker.

import gleam/javascript/promise
import rays/worker

/// Build the Worker.
pub fn main() -> worker.Worker {
  worker.new(fn(_request, _env, _context) {
    worker.ok()
    |> worker.string_body("Hello from app")
    |> promise.resolve
  })
}
