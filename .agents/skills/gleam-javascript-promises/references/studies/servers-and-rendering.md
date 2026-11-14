# JavaScript promises in servers and rendering

Research date: 2026-11-14. This study reads the repositories' default-branch snapshots, including Gleam declarations, JavaScript FFI, examples, tests, and dependency manifests. **Observed** describes source behavior; **inference** identifies a consequence or risk that was not reproduced at runtime; **recommendation** is the author's synthesis. No builds or browser/server integration tests were run.

## Snapshots and actual categorization

| Repository | Commit | Package version | Declared `gleam_javascript` | Committed resolution |
|---|---|---|---|---|
| [renatillas/tiramisu][t-config] | `d1e4403197fd230416909e01e25cfdf6a7c58a68` | 8.1.0 | >=1.0.0, <2.0.0 | 1.0.0 ([manifest][t-manifest]) |
| [MystPi/glen][g-config] | `2a3f8709242dbfbe2fd7fcc93d975f291adc49f4` | 2.2.3 | >=0.13.0, <2.0.0 | 1.0.0 ([manifest][g-manifest]) |
| [MystPi/conversation][c-config] | `fd9fb71a334fc989e27b3750a0c4f17c907f4a2f` | 2.0.2 | >=0.7.0, <2.0.0 | 1.0.0 ([manifest][c-manifest]) |
| [ghivert/redraw][r-config] | `f09d18e40e00ae139644d44a3106d74902c6c09c` | 19.2.3 | >=1.0.0, <2.0.0 | 1.0.0 ([manifest][r-manifest]) |

These are three distinct uses of promises, rather than four independent designs:

- **Glen and Conversation form one server stack.** Conversation converts standard JavaScript requests/responses and reads request bodies; Glen depends on Conversation and adds handlers and middleware. ([Conversation surface][c-api], [Glen dependencies][g-config])
- **Tiramisu is now a declarative renderer built on Lustre and Three.js.** Its promises load assets and produce deferred scene mutations; its README also records a migration away from GitHub. This report covers the GitHub snapshot, not subsequent development on Tangled. ([README][t-readme], [extension API][t-extension])
- **Redraw exposes React's promise-aware APIs.** Its inspected examples do not demonstrate application promise composition. Exporting an API and showing a tested usage pattern are different evidence. ([bindings][r-promises], [example][r-example], [test entrypoint][r-test])

The useful common distinction is that a promise represents eventual completion, while a `Result` inside it represents expected failure. The core library explicitly recommends that distinction and leaves JavaScript rejection untyped. ([Core contract][core-contract])

## Conversation: normalize body failures at the foreign boundary

**Observed.** `RequestBody` is a foreign type with a documented single-read lifetime. The surrounding HTTP request is the ordinary generic `gleam/http` request. `read_text`, `read_bits`, `read_json`, and `read_form` all return `Promise(Result(value, ReadError))`. `ReadError` distinguishes `AlreadyRead`, `ParseError(message)`, and `ReadError(message)`; JSON remains `Dynamic` for a later application decoder. ([Public types and readers][c-api])

The JavaScript helper `safeRead` centralizes the conversion. An already-used body yields `Error(AlreadyRead)`; `await cb()` lives inside `try`, so both a synchronous callback throw and a rejection from the body operation enter the same catch. It constructs `Ok(value)` on success, classifies `SyntaxError` and `TypeError` as `ParseError`, and maps other caught exceptions to `ReadError`. `readBits` awaits `arrayBuffer()` and constructs a Gleam bit array; form reading awaits `formData()` and then sorts and converts values/files. ([FFI readers][c-read-ffi])

The example server composes these boundaries cleanly: convert a JavaScript request synchronously, call the promise-returning Gleam handler, then `promise.map` the resolved response through the synchronous response converter. Form submission uses `promise.await` because the continuation returns another promise; completed HTML/text responses use `promise.resolve`. ([Server adapter][c-server-example], [form handler and response helpers][c-handler-example])

**Tasteful pattern / recommendation.** Keep foreign body consumption in one small adapter, expose a domain error type, and let application code decode JSON and choose its response. The promise does not need a second, typed rejection channel. Treat a body as a consumable resource: do not launch independent readers on the same `RequestBody`. This follows the explicit single-read contract, rather than treating its opaque type as immutable reusable data. ([Body lifetime and JSON contract][c-api])

**Hazards and evidence limits.** The catch accesses `e.message`, which assumes an Error-like rejection reason; this is not a universal normalizer for arbitrary JavaScript thrown values. Its classification also maps every caught `TypeError` to `ParseError`, regardless of which reader supplied it. These are source observations, not exhaustive runtime classifications. The `test/` program starts `Deno.serve` and displays a form; it contains no assertions exercising already-read, parse-failure, or rejection paths. ([Catch implementation][c-read-ffi], [example test program][c-server-example], [form handling][c-handler-example])

## Glen: a promise-shaped middleware pipeline

**Observed.** A Glen `Handler` is a function from `Request` to `Promise(Response)`. `serve` passes a converted request to the handler and maps the resolved response back to JavaScript. Synchronous response construction stays synchronous; callers finish with `promise.resolve` to meet the handler interface. ([Handler and server][g-server], [response constructors][g-responses])

Middleware follows the same continuation contract. `require_method` either calls `next()` or returns an already-resolved 405 response. Body middleware awaits Conversation's `Promise(Result(...))`, then delegates to a shared `handle_read_errors`: readable values call the continuation, parse/read failures become 400, and an already-consumed body is logged and becomes 500. Consequently `use <- glen.require_method(...)` and `use body <- glen.require_form(...)` retain a linear success path without hiding the HTTP policy. ([Method middleware][g-method], [body/error middleware][g-body])

`log` records the start, awaits the downstream handler, logs the resolved response and elapsed time, then resolves that response again. `rescue_crashes` deliberately accepts a **thunk**, not an already-started promise. Its FFI invokes and awaits `handler()` inside `try`, converting caught failure to a `Result`; Gleam then logs it and resolves a 500 response. This arrangement can catch an exception thrown while constructing the handler's promise as well as a later rejection. ([Logging and rescue][g-rescue], [rescue FFI][g-ffi])

The example's ordering is meaningful: logging wraps crash rescue, which wraps static serving and route selection. A rescued downstream crash becomes an ordinary 500 response that the outer logger can observe. ([Example middleware order][g-test])

**Tasteful patterns / recommendations.** Keep one return shape across synchronous and asynchronous routes; keep ordinary response helpers pure; put expected HTTP failure policy into shared middleware; pass a function when a boundary must catch failure during operation creation. Glen's readers reuse Conversation rather than duplicating its FFI. ([Response helpers][g-responses], [body delegates][g-readers], [rescue][g-rescue])

**Hazards and evidence limits.** Crash rescue is scoped to its handler thunk. `convert_response` is called later by the outer `serve` mapping, so a conversion failure is outside an inner `rescue_crashes` call. The FFI also assumes `e.message` is available. Further, a `Promise(Response)` signature does not make every operation nonblocking: file serving uses `Deno.openSync`, and existence checking uses `fs.existsSync`. Do not infer scheduler behavior from the return type. ([Server mapping][g-server], [file conversion][g-file-conversion], [FFI][g-ffi])

The repository's test program is an interactive HTTP/WebSocket example, not an assertion suite for middleware failure behavior. Promise flow is visible and instructive; its correctness under all runtime failures was not established by this study. ([Example test program][g-test])

## Tiramisu: promises produce actions, then the renderer checks ownership

**Observed.** Tiramisu does more than await a model and mutate the current scene. Its opaque `RuntimeAction` wraps a deferred runtime mutation. An extension request supplies an owner, logical request key, and `Promise(List(RuntimeAction))`; completion enters the renderer through a message. Mesh loading converts loader `Result`s into either object registration/replacement actions or a model-error event action. Background loading instead turns an expected error into an empty action list. ([Extension API][t-extension], [mesh loading][t-mesh], [background loaders][t-background])

Material texture loading demonstrates a useful fan-out/fan-in pattern. It constructs a list of per-slot promises, each maps `Ok(texture)` to an application action or `Error` to an error-event action, then `promise.await_list` joins them and `promise.map(list.flatten)` combines their action lists. Missing slots become resolved empty lists. Expected individual failures therefore remain resolved values rather than rejecting the whole join. ([Texture aggregation][t-texture-join], [per-slot conversion][t-textures])

The renderer registers a new version for each owner/key pair before observing completion. A resolution is dropped if its version is stale or owner is absent, queued during reconciliation or when no runtime is available, and applied otherwise. Queued actions are checked again when drained. This is application lifetime management layered over the promise, not a property supplied by `Promise` itself. ([Registration][t-register], [state machine][t-state], [draining][t-finalize])

This state machine has meaningful pure tests for current/stale versions, missing owners, queueing, and stale/missing queued actions. A separate interactive stress example cycles background changes, mesh replacements, failures, and owner removal. Those tests verify the decision logic; the example describes a manual exercise rather than proving all browser timing cases. ([State tests][t-tests], [stress example][t-stress])

**Exact dependency FFI verified.** Tiramisu's committed manifest pins Savoiardi `0293cd9b627cb1580787c3384b911e96619676da`, version 4.0.0. Inspection of that exact commit confirms `Promise(Result(asset, savoiardi.LoadError))` loader APIs: `loadAsync` resolves an empty URL to `EmptyUrl`, maps fulfilled loads to `Ok`, converts rejections through `load_error`, and catches direct loader throws as `InvalidUrl`. The error ADT also distinguishes HTTP, resource, parse, and other load failures. These are its normal error paths, not a guarantee against every exception in error conversion. ([Locked manifest][t-manifest], [Savoiardi version][s-config], [texture API][s-textures], [model API][s-models], [error ADT][s-errors], [FFI][s-load]) The dependency mismatch remains: Tiramisu's `gleam.toml` requests Hex >=5.0.0, <6.0.0, while its committed manifest records this version 4.0.0 git dependency. ([Declared dependency][t-config], [manifest][t-manifest])

**Tasteful pattern / recommendation.** Return declarative or deferred results, route completion through the application's message loop, and validate request identity at application time. Separate this deterministic policy from asset I/O so it can be tested without a GPU or network. Preserve enough request identity to reject an older completion after a newer request begins. ([Action representation][t-extension], [state machine][t-state], [tests][t-tests])

**Hazards and counterexamples.**

- The renderer observes extension tasks with `promise.map` and discards the returned promise; it has no rejection branch there. A custom extension's native rejection or a panic in its continuation can bypass the result/action protocol. The `Promise(List(RuntimeAction))` type alone does not guarantee fulfillment. ([Observer][t-register], [core rejection contract][core-contract])
- Logical invalidation is not cancellation. The task is already supplied as a promise, and `Drop` returns no effect; these APIs contain no abort/dispose callback for the dropped result. Resource cleanup for discarded loaded assets requires separate design. This is an inference about the interface, not a measured resource leak. Also, `CustomOwner` is always considered present, so its lifetime is not checked as a DOM node's is. ([Request signature][t-extension], [drop path][t-apply], [owner checks][t-owners])
- **Source-derived race to investigate:** switching an in-flight texture background to a solid color or no background does not register a replacement `background` request. Those branches mutate synchronously; `SceneOwner` remains present, and the older version may still be current when it resolves. An earlier texture could therefore overwrite the later solid/empty choice. This was not reproduced in a browser and is not covered by the inspected state tests. The broader lesson is that invalidation must cover changes that start **no** replacement I/O, as well as changes that start another request. ([Background branches][t-background-switch], [owner checks][t-owners], [version registration][t-state], [tests][t-tests])

## Redraw: React consumes the promise

**Observed.** Redraw's `use_promise` directly binds React's `use`, taking `Promise(state)` and returning `state` to rendering code. Its documentation associates pending work with the nearest Suspense fallback, and `redraw.suspense` wraps React's Suspense component. This is a renderer-managed suspension boundary, not `promise.await` in a Gleam effect callback. `act` is a separate promise-returning test-helper binding. ([Promise hooks][r-promises], [Suspense declaration][r-suspense], [Suspense FFI][r-suspense-ffi], [act][r-act])

Redraw does not add a `Result` conversion around `use_promise`. **Recommendation/inference:** when application failures should remain ordinary rendered data, supply a promise that resolves to a `Result` and handle that result in the component. A promise-aware UI binding does not by itself establish an application error policy. ([Direct binding][r-promises], [core result/rejection distinction][core-contract])

**A concrete FFI counterexample.** `use_async_transition` is declared as returning a boolean and a zero-argument function returning `Promise(Nil)`, directly bound to `react.useTransition`. The neighboring synchronous declaration also gives the returned starter zero arguments. React's own GitHub documentation says that the returned `startTransition` accepts an action callback and returns nothing. These declarations therefore do not describe the documented foreign API: an asynchronous **action supplied to** a transition is different from a transition starter **returning** a promise. This is a source/documentation mismatch; no runtime reproduction was performed. ([Redraw signatures][r-promises], [React-owned documentation, inspected 2026-11-14][react-transition])

The inspected Redraw test entrypoint only invokes `gleeunit.main`; the DOM and example tests are placeholder equality checks. They do not validate `use_promise`, rejection behavior, Suspense, async transitions, or `act`. Treat these bindings as interoperability examples whose foreign contracts need verification, not as proven application orchestration patterns. ([Core tests][r-test], [DOM tests][r-dom-test], [example tests][r-example-test])

## Version and copying considerations

The stable lesson across these snapshots is the composition shape: `map` for a synchronous transformation of a resolved value, `await` for a continuation returning another promise, `resolve` for immediate values, and `await_list` for joining a list. Current core source preserves those distinctions. None of these four projects' inspected promise call sites depends on the old numbered `awaitN`/`raceN` family removed in `gleam_javascript` 1.0. ([Core functions][core-composition], [1.0 changelog][core-changelog])

Do not copy historical JavaScript representations alongside those stable Gleam call patterns. Glen and Conversation construct class-based `Ok`/`Error` values, while current `gleam_javascript` FFI uses `Result$Ok`/`Result$Error` constructor functions; its 1.0.1 changelog explicitly records an FFI API update and its manifest requires Gleam >=1.13.0. This is a migration-sensitive boundary, not evidence that changing a dependency constraint alone makes the older adapters compatible. ([Glen FFI][g-ffi], [Conversation FFI][c-read-ffi], [current core FFI][core-ffi], [changelog][core-changelog], [compiler requirement][core-config])

Redraw's snapshot requires Gleam >=1.13.0, and its example resolves React 19.2.3. Its React hooks must be evaluated against that foreign runtime as well as the Gleam dependency graph. Tiramisu additionally needs its declared and committed Savoiardi dependencies reconciled before treating a fresh build as equivalent to this source reading. ([Redraw config][r-config], [React lock][r-react-lock], [Tiramisu config][t-config], [Tiramisu manifest][t-manifest])

## Verification limits

All four requested repositories were available and their promise-facing code was inspected, including loader APIs and FFI at Tiramisu's exact locked Savoiardi commit. React's transition documentation is the only mutable source link below; all repository code citations use full commit SHAs and line anchors. No Hex artifact equivalence, compiler/runtime compatibility, network asset loading, or browser/server behavior was executed or claimed verified.

[t-config]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/gleam.toml#L1-L22
[t-manifest]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/manifest.toml#L4-L42
[t-readme]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/README.md#L1-L14
[t-extension]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/dev/extension.gleam#L27-L178
[t-mesh]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/mesh.gleam#L186-L284
[t-background]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/scene.gleam#L306-L354
[t-background-switch]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/scene.gleam#L225-L293
[t-texture-join]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/material.gleam#L268-L280
[t-textures]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/material.gleam#L393-L439
[t-register]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/renderer.gleam#L346-L364
[t-state]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/internal/async_state.gleam#L21-L118
[t-finalize]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/renderer.gleam#L403-L443
[t-apply]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/renderer.gleam#L446-L477
[t-owners]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/src/tiramisu/renderer.gleam#L641-L661
[t-tests]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/test/tiramisu/async_state_test.gleam#L8-L91
[t-stress]: https://github.com/renatillas/tiramisu/blob/d1e4403197fd230416909e01e25cfdf6a7c58a68/examples/03-assets/03-async-capabilities/README.md#L1-L15
[s-textures]: https://github.com/renatillas/savoiardi/blob/0293cd9b627cb1580787c3384b911e96619676da/src/savoiardi/texture.gleam#L144-L189
[s-config]: https://github.com/renatillas/savoiardi/blob/0293cd9b627cb1580787c3384b911e96619676da/gleam.toml#L1-L16
[s-errors]: https://github.com/renatillas/savoiardi/blob/0293cd9b627cb1580787c3384b911e96619676da/src/savoiardi.gleam#L1-L8
[s-models]: https://github.com/renatillas/savoiardi/blob/0293cd9b627cb1580787c3384b911e96619676da/src/savoiardi/object.gleam#L223-L260
[s-load]: https://github.com/renatillas/savoiardi/blob/0293cd9b627cb1580787c3384b911e96619676da/src/savoiardi.ffi.mjs#L196-L209
[c-config]: https://github.com/MystPi/conversation/blob/fd9fb71a334fc989e27b3750a0c4f17c907f4a2f/gleam.toml#L1-L21
[c-manifest]: https://github.com/MystPi/conversation/blob/fd9fb71a334fc989e27b3750a0c4f17c907f4a2f/manifest.toml#L4-L13
[c-api]: https://github.com/MystPi/conversation/blob/fd9fb71a334fc989e27b3750a0c4f17c907f4a2f/src/conversation.gleam#L1-L103
[c-read-ffi]: https://github.com/MystPi/conversation/blob/fd9fb71a334fc989e27b3750a0c4f17c907f4a2f/src/ffi.mjs#L53-L111
[c-server-example]: https://github.com/MystPi/conversation/blob/fd9fb71a334fc989e27b3750a0c4f17c907f4a2f/test/conversation_test.gleam#L1-L47
[c-handler-example]: https://github.com/MystPi/conversation/blob/fd9fb71a334fc989e27b3750a0c4f17c907f4a2f/test/conversation_test.gleam#L62-L95
[g-config]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/gleam.toml#L1-L24
[g-manifest]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/manifest.toml#L4-L26
[g-server]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L60-L117
[g-file-conversion]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L120-L160
[g-responses]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L216-L244
[g-readers]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L291-L317
[g-method]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L343-L354
[g-body]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L382-L505
[g-rescue]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.gleam#L557-L617
[g-ffi]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/src/glen.ffi.mjs#L1-L43
[g-test]: https://github.com/MystPi/glen/blob/2a3f8709242dbfbe2fd7fcc93d975f291adc49f4/test/glen_test.gleam#L1-L135
[r-config]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/gleam.toml#L1-L30
[r-manifest]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/manifest.toml#L4-L13
[r-promises]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/src/redraw.gleam#L296-L345
[r-suspense]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/src/redraw.gleam#L167-L175
[r-suspense-ffi]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/src/redraw.ffi.mjs#L214-L217
[r-act]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/src/redraw.gleam#L491-L496
[r-test]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw/test/redraw_test.gleam#L1-L5
[r-dom-test]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/redraw_dom/test/redraw_dom_test.gleam#L1-L12
[r-example-test]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/example/test/example_test.gleam#L1-L12
[r-example]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/example/src/example.gleam#L1-L73
[r-react-lock]: https://github.com/ghivert/redraw/blob/f09d18e40e00ae139644d44a3106d74902c6c09c/example/yarn.lock#L3681-L3683
[react-transition]: https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/useTransition.md
[core-contract]: https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L4-L22
[core-composition]: https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam/javascript/promise.gleam#L43-L145
[core-changelog]: https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/CHANGELOG.md#L3-L12
[core-ffi]: https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/src/gleam_javascript_ffi.mjs#L1-L24
[core-config]: https://github.com/gleam-lang/javascript/blob/b51b4365c2b5fa3f9767a349a7e7a68a874264cb/gleam.toml#L1-L7
