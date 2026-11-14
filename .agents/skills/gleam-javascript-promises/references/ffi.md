# Promise boundaries and FFI

Read the foreign implementation and generated JavaScript together. Gleam checks a declaration's use but trusts its correspondence with JavaScript. [Official externals guide](https://gleam.run/documentation/externals/).

## Match the runtime representation

An ordinary native JavaScript promise can satisfy `Promise(a)` directly. Its fulfillment value must be the runtime representation of `a`. For `Promise(Result(a, e))`, resolve to real Gleam result constructors instead of a JavaScript lookalike object.

Inspect generated output for imports, constructors, record fields, lists, `Nil`, and bit arrays. Historical repositories use different compiler ABIs. In the example below, Gleam 1.19.2 provides `Result$Ok` and `Result$Error` from `./gleam.mjs`. Copying `new Ok(...)`, numeric record fields, or a prelude path from another compiler version is not an ABI check. The 1.0.1 library [updated its FFI API](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/CHANGELOG.md#L3-L5).

`PromiseLayer` belongs to the library's handling of **nested promise payloads**. Its wrapping uses `instanceof Promise`, not general thenable detection, and is not applied identically by every combinator. Use `await` for normal chaining and runtime-test intentionally nested promises crossing custom JavaScript or collection combinators. [Implementation](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L42-L114).

## Convert host failure into data

`host.gleam` exposes one fallible file operation. Returning the original rejection reason as `Dynamic` lets callers wrap/decode it for their domain without assuming `.message` or `.toString()` exists.

```gleam
import gleam/dynamic.{type Dynamic}
import gleam/javascript/promise.{type Promise}

/// Read UTF-8 text, returning host failures as values.
@external(javascript, "./host_ffi.mjs", "read_text")
pub fn read_text(path: String) -> Promise(Result(String, Dynamic))
```

`host_ffi.mjs`, for Node with the generated constructor API described above:

```javascript
import { readFile } from "node:fs/promises";
import { Result$Ok, Result$Error } from "./gleam.mjs";

export async function read_text(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (reason) {
    return Result$Error(reason);
  }
  return Result$Ok(text);
}
```

The `await` inside `try` catches asynchronous rejection as well as a synchronous throw from the host call. Returning a promise directly from a synchronous `try` exits that catch before later rejection. Attaching `.catch` after a host call also cannot catch a throw that happened before a promise was returned.

Scope the catch to the foreign work the contract normalizes. Broad recovery around domain callbacks can hide programmer errors; propagate or report them at the established boundary. Some APIs deliberately expose native rejection, such as framework promise-consumption primitives; preserve that behavior unless the task changes the contract. Fetch's [await-inside-try pattern](https://github.com/gleam-lang/fetch/blob/a0f47f1694506c34bff0513fa41ced168a73206a/src/gleam_fetch_ffi.mjs#L22-L28) is instructive; its error stringification also shows why arbitrary rejection reasons need explicit handling in new adapters.

## Adapt callbacks with a settlement contract

Return an existing native promise or chain directly. Allocate a new promise to bridge a callback protocol, rather than wrapping a chain that already represents completion. Use an ordinary executor with explicit settlement; `new Promise(async (...) => ...)` ignores the executor's returned promise, so its later rejection does not settle the outer promise. An `async` function with `await` is the simpler adapter for an already promise-based host API. [Promise constructor algorithm](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise-executor).

Use `promise.new` when one callback registration owns the resolver. Use `promise.start` when the promise and resolver need separate storage or lifetimes. They expose resolution, so represent expected callback failure as a fulfilled `Error`. Both create promises immediately; first settlement wins, while resources still need cleanup. [Constructors](https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L28-L46).

For each adapter, establish these properties:

- Every documented success, failure, and cancellation callback settles with the declared shape. A `complete` callback that only invokes an observer does not settle a newly created promise.
- Settlement represents the promised milestone. Resolving immediately after starting `setData`, a write, or an animation represents scheduling unless the API explicitly promises that weaker contract.
- Later callback throws have their own boundary. The executor's automatic rejection covers its synchronous execution, not arbitrary event callbacks invoked later.
- Buffered and waiting-consumer queue paths deliver the same representation. Apply `Some`, `Ok`, decoding, or wrapping exactly where the contract requires it.
- Remove listeners and release references when finished. Define abandoned-operation behavior if callbacks may never run; add timeout/cancellation when the caller's lifetime needs it.

The Plinth, Etch, and WeChat studies contain concrete failures of these contracts. See [sources.md](sources.md) for evidence.

## Carry resource lifetime separately

A promise provides eventual settlement, not progress, events, unsubscription, or abort. Keep a separate control handle or subscription. A host wrapper can return `#(Task, Promise(Result(a, e)))` so callers can await completion and still abort or observe progress.

IndexedDB request success and transaction commit are different milestones. Fetch response availability and body consumption are also distinct. Consume bodies deliberately, keep stream readers owned, and release/cancel resources according to the host protocol. Racing a timeout does not stop the request or free its resources.

Associate UI completions with their owner and request generation when they could arrive after disposal or replacement. Abort where supported, and gate stale messages when abort cannot suppress already-completing results. Keep JavaScript animation/timing promises private when Gleam callers have no need to compose their completion.
