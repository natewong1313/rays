# Promise semantics and the Fetch boundary

Reviewed 2026-11-14 from public GitHub default-branch snapshots. These notes describe the inspected commits, not every released version. Recommendations below are deductions from the source, distinguished from observed implementation. The other studies are linked from [the research index](../sources.md).

## gleam-lang/javascript

Snapshot: [`b51b4365c2b5fa3f9767a349a7e7a68a874264cb`](https://github.com/gleam-lang/javascript/tree/b51b4365c2b5fa3f9767a349a7e7a68a874264cb), package `gleam_javascript` 1.0.1, requiring Gleam >=1.13.0. This repository defines the typed promise API; its raw JavaScript implementation is not an example of an application avoiding that API. [Package configuration](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/gleam.toml#L1-L10).

### Observed design

`Promise(value)` describes the fulfillment value only. Rejection has no type parameter: arbitrary JavaScript exceptions and Gleam panics can change its value. Module documentation explicitly recommends putting `Result` inside the promise when success and failure need types. Merely declaring `Promise(Result(a, e))` on an external does not implement error conversion. [Type and rationale](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L4-L26).

The API separates synchronous transformation from asynchronous sequencing:

| Operation | Callback/output contract | Consequence |
| --- | --- | --- |
| `map` | `a -> b` | Transforms any fulfilled value, including a `Result` as a whole. |
| `await` | `a -> Promise(b)` | Chains a dependent asynchronous step. |
| `map_try` | `a -> Result(b, e)` | Runs a synchronous fallible step only on `Ok`; preserves `Error(e)`. |
| `try_await` | `a -> Promise(Result(b, e))` | Runs an asynchronous fallible step only on `Ok`; preserves `Error(e)`. |
| `tap` | `a -> b`, retaining original `a` | Runs a callback and discards its return; asynchronous callback work is not joined. |
| `rescue` | `Dynamic -> a` | Recovers native rejection into an ordinary fulfillment value. It does not inspect a fulfilled `Error`. |

Both `try` combinators preserve the same error type `e`; mapping different external errors into a shared domain type is the caller's job. `rescue` has a synchronous recovery callback, unlike JavaScript's permissive promise-returning catch handlers. [Combinator definitions](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L48-L121).

The runtime representation is an ordinary native JavaScript promise. The private `PromiseLayer` wraps a **promise used as a fulfillment value**, preventing normal JavaScript promise assimilation from silently collapsing the declared nested type. `resolve`, `new`, `start`, and `map` wrap such payloads; `map` and `await` unwrap the incoming payload before invoking their callback. `await` deliberately chains the callback's returned promise. It follows that `map(p, async_step)` and `await(p, async_step)` have different semantics even though native `.then` would flatten either callback result. [Implementation](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L42-L92), [nested-promise tests](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/test/gleam/javascript/promise_test.gleam#L12-L65).

That protection is not a universal adapter for arbitrary thenables or promises from another realm: `wrap` uses `instanceof Promise`. Aggregators call native `Promise.all`/`Promise.race` directly, and `rescue` returns its callback result without `PromiseLayer.wrap`. **Recommendation:** intentionally nested promises and custom JavaScript combinators need specific interoperability tests. Normal application sequencing should flatten deliberately with `await`; applications should not inspect or reproduce `PromiseLayer`. [Exact implementations](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L49-L114).

`new` runs its executor through native `new Promise`, but exposes only the resolve callback to Gleam. `start` returns a promise/resolver pair. They adapt callback protocols; they do not supply a typed rejection channel, cancellation, a timeout, or a guarantee that a callback will ever run. `wait` schedules `setTimeout`. [Constructors and timer](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L58-L98).

`await_list` and `await_array` aggregate already-created promises. They preserve input order and reject when a member rejects, following native `Promise.all`; a fulfilled Gleam `Error` is simply a value. Thus a list of `Promise(Result(a, e))` yields `Promise(List(Result(a, e)))`, not an automatic fail-fast typed traversal. A race observes the first settlement, including rejection. Neither aggregator cancels the other operations. The core implementation contains no concurrency limiter or cancellation protocol. [Gleam API](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L123-L169), [native delegation](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L100-L114), [ECMAScript algorithms](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.all).

### Taste and compatibility

The useful abstraction is small: use the typed combinator that matches the callback's actual return type, retain the returned chain, and leave application failure as ordinary data. An extra async wrapper is unnecessary for a synchronous transformation; the current Fetch source's `try_await` followed immediately by `resolve(Ok(...))` can be expressed more directly with `map` plus `result.map`, or `map_try` when the callback itself returns `Result`.

Version context matters. `then`/`then_try` became `await`/`try_await` in 0.3; `start`/`wait` arrived in 0.13; 1.0 removed numbered `awaitN`/`raceN`; 1.0.1 updated the FFI API. Several studied packages lock 1.0.0 even when their version constraint allows something else. **Recommendation:** inspect the installed source and compiler output, not just dependency bounds or copied examples. [Changelog](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/CHANGELOG.md#L3-L50).

## gleam-lang/fetch

Snapshot: [`a0f47f1694506c34bff0513fa41ced168a73206a`](https://github.com/gleam-lang/fetch/tree/a0f47f1694506c34bff0513fa41ced168a73206a), `gleam_fetch` 1.4.1, requiring Gleam >=1.14.0 and allowing `gleam_javascript` >=0.3.0 and <2.0.0. [Configuration](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/gleam.toml#L1-L20).

### Observed use

The package exposes opaque native request/response/body-reader types and a typed asynchronous surface: sending a request produces `Promise(Result(Response(FetchBody), FetchError))`; body readers produce another promise containing a response with a typed body. Fetching headers and consuming a body are separate asynchronous operations. Streaming reads produce `Promise(Result(Option(BitArray), FetchError))`, distinguishing a chunk, clean end-of-stream, and failure. [Types and send](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam/fetch.gleam#L8-L84), [body/stream APIs](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam/fetch.gleam#L211-L295).

The FFI catches native request rejection with `try { ... await fetch(...) ... }` and returns a Gleam `Error(NetworkError(...))`. Text/bytes/JSON reads similarly convert body-consumption failures into typed errors. `read_chunk` awaits the stream reader inside its catch boundary and returns typed `Some`, `None`, or `UnableToReadBody`. This is a strong pattern for a foreign API whose expected failures belong in Gleam. [FFI request boundary](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam_fetch_ffi.mjs#L22-L28), [body boundaries](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam_fetch_ffi.mjs#L75-L125).

The normalization is scoped, not a proof that every call is rejection-free. Request conversion runs synchronously before `raw_send`; `error.toString()` in the request catch assumes a non-nullish reason with a usable method. The FormData binary conversion exposes `Promise(List(BitArray))` and uses `Promise.all` with no catch. **Recommendation:** document the actual boundary and test arbitrary rejection reasons for new wrappers; retain native rejection where deliberately part of the contract rather than assuming a typed signature catches everything. [Request construction](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam_fetch_ffi.mjs#L35-L66), [FormData conversion](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam_fetch_ffi.mjs#L185-L201).

A 500 response is a successful transport result: callers inspect `response.status` to decide application success. Bodies are consumable resources; a second read can fail. Library tests sequence send and body-read with `try_await`, then return the final promise from the test. A deterministic failing stream fixture tests `read_chunk` without network access. [Error documentation](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam/fetch.gleam#L8-L23), [returned test chain](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/test/gleam_fetch_test.gleam#L15-L58), [stream test](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/test/gleam_fetch_test.gleam#L232-L242).

### Lessons from imperfections

The 1.4.1 release fixed a stream error returning `Error(Nil)` when its type promised `Error(FetchError)`. This is direct evidence that a checked Gleam signature does not validate the JavaScript implementation. Exercise failure shapes as well as successful values. [Fix recorded in changelog](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/CHANGELOG.md#L3-L6).

The documentation example for `from_fetch_response` supplies it directly to `map_try`, although it returns a plain `Response`, whereas `map_try` requires a `Result` callback. Treat documentation snippets as candidates to compile, not evidence that an API composition type-checks. [Example and signature](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam/fetch.gleam#L188-L209), [actual `map_try` contract](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L88-L100).

## Validation scope

The source review covers both libraries' implementation, API declarations, tests, configuration, and changelogs. The companion skill's validation uses an isolated Gleam JavaScript project and local stubbed host APIs; it does not run Fetch's external-network test suite or claim all studied repositories build with a current compiler. See [the research index](../sources.md) for the final validation record.
