//// The smallest rays Worker.

import gleam/javascript/promise
import rays/workers

/// Build the Worker.
pub fn main() -> workers.Worker {
  workers.new(fn(_request, _env, _context) {
    workers.ok()
    |> workers.string_body("Hello from app")
    |> promise.resolve
  })
}
