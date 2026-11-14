---
name: gleam-javascript-promises
description: "Use whenever designing, writing, reviewing, debugging, or explaining JavaScript promises in Gleam: gleam/javascript/promise, Promise-returning APIs, async effects or handlers, and JavaScript/TypeScript FFI that creates, returns, or consumes promises for Gleam, including code without a typed promise import."
---

# JavaScript promises in Gleam

Keep asynchronous work owned, failures typed where callers handle them, and foreign contracts honest. Use the project's established libraries and runtime conventions; these rules apply to native JavaScript promises used by Gleam as well as `gleam/javascript/promise`.

## Establish the contract

Before changing a promise path, inspect its Gleam declaration, JavaScript implementation, caller, and installed dependency version. Identify what starts the work, what completion means, who observes the returned promise, and how expected failure, native rejection, and cancellation reach that owner. This step is complete when each channel has an explicit contract.

- `Promise(a)` describes fulfillment. Use `Promise(Result(a, e))` for expected fallible operations; the foreign implementation must actually convert expected failures into `Error(e)`.
- Native rejection is separate and untyped. A Gleam panic or JavaScript exception can still reject a chain. `try_await` handles fulfilled `Error` values; `rescue` handles rejection. Choose recovery or propagation deliberately rather than converting programmer errors into successful defaults.
- Keep an operation synchronous when its result is available synchronously. For a host protocol with immediate setup failure and later completion, `Result(Promise(a), SetupError)` can be appropriate.
- Respect the runtime boundary: use JavaScript promises on the JavaScript target. Shared libraries need target-specific implementations or an existing cross-target abstraction.

## Compose by callback return type

| Work in the callback | Combinator | Callback returns |
| --- | --- | --- |
| Transform a fulfilled value | `promise.map` | `b` |
| Start dependent asynchronous work | `promise.await` | `Promise(b)` |
| Transform `Ok`, preserving the error type | `promise.map_try` | `Result(b, e)` |
| Start async work on `Ok`, preserving the error type | `promise.try_await` | `Promise(Result(b, e))` |
| Observe a value and retain it | `promise.tap` | A discarded synchronous result |
| Recover native rejection | `promise.rescue` | A fulfillment value, from `Dynamic` |

Use `use value <- promise.await(...)` or `use value <- promise.try_await(...)` for a readable dependent sequence. End an asynchronous continuation with a promise; `promise.resolve(...)` lifts a synchronous final value when needed. A `map`/`map_try` continuation returns its ordinary value/`Result` directly.

Gleam's `map` preserves a returned promise as a **nested value**; it does not perform `await`'s chaining. `tap` discards a callback's returned promise and cannot wait for its work. Return or await the final chain so request handlers, effects, and tests observe completion and failure.

`map_try` and `try_await` retain the same error type. Convert unrelated errors into a shared domain error with `result.map_error` inside `promise.map` before composing them. `rescue` takes a synchronous recovery function; asynchronous recovery needs explicit chaining or a small foreign adapter with the correct contract.

For complete examples of fetch/body sequencing, error conversion, and typed result collection, read [composition.md](references/composition.md).

## Keep foreign boundaries small

When adding or changing an external, callback adapter, or raw `.then`/`async` implementation, read [ffi.md](references/ffi.md) before editing. It covers runtime representation, generated constructors, catching throws and rejections, callback settlement, and resource lifetimes.

Keep host API calls and representation conversion in FFI; put domain branching and orchestration in Gleam. A native promise is a valid `Promise(a)` when its fulfillment value matches `a`. The library's private `PromiseLayer` protects nested promise payloads; applications do not need to wrap ordinary FFI promises in it.

## Own concurrency and lifetime

- Create dependent work inside an `await` continuation. Promise creation starts work according to the host operation; a promise is not a lazy task.
- Aggregate independent work with `await_list`/`await_array`. They preserve input order. A fulfilled `Error` remains data: collecting `Promise(Result(a, e))` yields a collection of results. Choose explicitly whether to retain every outcome or combine them afterward.
- For large or rate-limited workloads, limit how many operations are **started**. `await_list` is a join, not a concurrency limiter. Joining an eagerly mapped list has already started every member.
- Treat `race_list`/`race_array` as first-settlement observation, including rejection. Timeouts and race winners do not cancel other work. Use the host's abort/task handle when cancellation is needed; preserve it alongside the promise.
- Deliver UI completions through the framework's message/action mechanism. When an owner can disappear or a newer request supersedes old work, gate results by owner identity or request version. Invalidate superseded work even when the new choice starts no I/O.
- At a callback boundary returning `Nil`, start asynchronous work deliberately, observe completion/rejection through an owned chain or framework hook, and return `Nil` explicitly. A host callback that ignores its return value will not wait for an `async` callback.

## Verify the foreign contract

Compile and format changed Gleam code for the project's target. Run relevant runtime checks: the type checker trusts external declarations.

Exercise the success and failure paths affected by the change. For adapters, prove each documented terminal path settles with the declared shape; include synchronous throws and asynchronous rejection where the host permits both. For queues, compare buffered and waiting-consumer paths. For lifetime changes, check stale completion, timeout/cancellation, and cleanup as applicable.

Return the final promise from asynchronous tests or await it in the harness. Verify the installed runner actually awaits it; a discarded assertion chain can fail after a test reports success. Report unexecuted runtime checks precisely.

## Source discipline

Check installed APIs before copying examples: older packages use removed numbered combinators and older Gleam constructor representations. The source basis is `gleam_javascript` 1.0.1, whose [combinators](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L48-L121) and [FFI](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L42-L114) define the semantics above. See its [history](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/CHANGELOG.md#L3-L50) for older dependencies.

For repository precedent or the evidence behind a rule, use [sources.md](references/sources.md). Observed patterns are evidence to evaluate, rather than universal rules to copy.
