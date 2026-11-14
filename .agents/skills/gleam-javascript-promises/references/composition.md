# Composing asynchronous Gleam

These examples target `gleam_javascript` 1.0.1 and `gleam_fetch` 1.4.1. Apply the repository's Gleam conventions before editing code. Each fenced Gleam example is a complete module.

## Dependent requests and synchronous decoding

`composition.gleam` keeps transport failures, HTTP status, and parsing failures distinct. Sending a request and reading its body are asynchronous; checking status and parsing text are synchronous.

```gleam
import gleam/fetch
import gleam/http/request.{type Request}
import gleam/int
import gleam/javascript/promise.{type Promise}
import gleam/result

/// Failures while loading a count from an HTTP endpoint.
pub type LoadError {
  /// Sending the request or reading its body failed.
  Transport(reason: fetch.FetchError)
  /// The endpoint returned a status other than 200.
  UnexpectedStatus(status: Int)
  /// The response text was not an integer.
  InvalidCount
}

/// Load a count, accepting only a 200 response containing an integer.
pub fn load_count(request: Request(String)) -> Promise(Result(Int, LoadError)) {
  use response <- promise.try_await({
    fetch.send(request)
    |> promise.map(fn(outcome) { result.map_error(outcome, Transport) })
  })
  use response <- promise.map_try({
    fetch.read_text_body(response)
    |> promise.map(fn(outcome) { result.map_error(outcome, Transport) })
  })
  case response.status {
    200 -> int.parse(response.body) |> result.map_error(fn(_) { InvalidCount })
    status -> Error(UnexpectedStatus(status))
  }
}
```

The outer `try_await` continuation returns the promise produced by `map_try`. The inner continuation returns a `Result` directly. Both transport steps normalize their error into `LoadError` before composition. An HTTP error status is separate from network failure; the body is read once.

This follows Fetch's [send/body separation](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam/fetch.gleam#L211-L249) while keeping pure transformations out of unnecessary `resolve`/`await` pairs.

## Independent work and typed aggregation

`collection.gleam` deliberately starts every supplied job, waits for all fulfilled outcomes, then combines their typed results. A typed error does not cancel or short-circuit already-started jobs.

```gleam
import gleam/javascript/promise.{type Promise}
import gleam/list

/// Start independent jobs and combine their results after they finish.
pub fn gather(
  jobs: List(fn() -> Promise(Result(a, e))),
) -> Promise(Result(List(a), e)) {
  jobs
  |> list.map(fn(start) { start() })
  |> promise.await_list
  |> promise.map(fn(outcomes) {
    list.try_map(outcomes, fn(outcome) { outcome })
  })
}
```

This returns the first typed error in **input order** after the join, rather than the first error in completion order. To retain every outcome, return the `await_list` chain directly and declare `Promise(List(Result(a, e)))`. Native rejection still rejects the join; when every outcome must be collected, normalize expected host rejections into results at each operation's boundary.

For sequential jobs, start the next job inside the preceding continuation. For bounded concurrency, use the project's worker pool or batch scheduler and feed it not-yet-started jobs. The aggregation API has no scheduling limit. [Implementation](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L100-L114).

## Effects, callbacks, and tests

A framework callback declared `fn(...) -> Nil` owns a synchronous return contract. Start a chain that eventually dispatches a typed message, observe failure at the established boundary, then return `Nil`. Choose the framework's existing effect constructor instead of changing its callback type to a promise. A host that ignores callback returns cannot join an async callback's completion.

Synchronous observation belongs in `tap`; required asynchronous side effects belong in `await`, returning a chain that maps back to the original value if necessary. Likewise, return the chain containing assertions from an async test, and use a runner that awaits it. These are completion contracts: initiating a promise and observing its settlement are different operations.
