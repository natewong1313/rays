# Repository evidence

Research date: 2026-11-14. The studies pin GitHub source to full commit SHAs, inspect declarations alongside FFI/callers/tests, and distinguish observations, source-derived risks, and recommendations. Package versions and locks describe those snapshots, not a guarantee that current HEAD equals a release artifact.

Read the study matching the integration being changed:

| Study | Repositories | Useful evidence |
| --- | --- | --- |
| [Core and Fetch](studies/core-library-and-fetch.md) | `gleam-lang/javascript`, `gleam-lang/fetch` | Nested-promise protection; combinator contracts; typed errors versus rejection; body/stream consumption; FFI error-shape regression. |
| [Servers and rendering](studies/servers-and-rendering.md) | `renatillas/tiramisu`, `MystPi/glen`, `MystPi/conversation`, `ghivert/redraw` | Handler composition; thunk-based crash rescue; owner/version gates and deferred actions; React promise consumers and foreign signature mismatch. |
| [Browser and effects](studies/browser-and-effects.md) | `lustre-labs/lustre`, `CrowdHailer/plinth`, `lustre-labs/ui`, `bananaofhappiness/etch` | Effect-owned initiation; microtask/render phases; callback adapters; pending error paths; buffered versus waiting queues. |
| [SDKs and tooling](studies/sdk-and-tooling.md) | `kaiwu/weapp`, `kaiwu/wechat_dev_tools`, `Enderchief/esgleam`, `gleam-lang/stdlib` | Task handles plus completion; unsettled wrappers; phase/batch aggregation; detached watch setup; hidden promises and incidental hashing. |

The inventory has important scope corrections. Tiramisu is a declarative Three.js renderer, not a web-server helper. Lustre core keeps native promises behind effects while one server example imports typed promises. Etch's promise adapter is a nested JavaScript terminal package. UI has raw promise FFI without typed imports. The JavaScript library itself defines the typed API; stdlib's dictionary check is incidental identity hashing, not async orchestration. The linked studies cite the source for each correction.

## Validation record

The studies state their own limits. Isolated Node probes use real FFI function bodies with minimal host/constructor stubs for Etch queues, Plinth IndexedDB, and WeChat SDK/build tooling; Plinth readline is also exercised against an actual Node interface. They verify narrow settlement/shape findings, not complete platform integration.

All three fenced Gleam examples were extracted, compiled, and format-checked using Gleam 1.19.2 with `gleam_javascript` 1.0.1, `gleam_fetch` 1.4.1, stdlib 1.0.5, and HTTP 4.5.0. Fourteen Node 26.13.1 runtime checks covered core semantics and compiled examples, including typed errors versus rejection, collection order, race lifetime, body consumption, and actual generated Result constructors. An independent agent used the skill for a separate callback-SDK adapter: compilation, formatting, and six async-aware runtime tests passed without a blocking ambiguity.

Full browser, WeChat, server, GPU/asset-loading, and external-network test suites are outside that validation. Tiramisu's exact locked Savoiardi revision was inspected, including its promise loader APIs and FFI; the study records its declared-versus-locked dependency mismatch. React's external documentation is explicitly identified as mutable in its study.
