# JavaScript promises in SDK bindings and build tools

Inspected on 2026-11-14 from freshly cloned default branches. Links below pin the exact inspected commits. **Observation** describes repository source; **inference** explains its consequences or a practice to transfer. The isolated probes at the end substitute host APIs and generated Gleam constructors; they do not establish behavior inside WeChat or against a real esbuild installation.

## Snapshot and classification

| Repository / commit | Classification and dependency context |
|---|---|
| `kaiwu/weapp` — `f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa` | WeChat SDK callback adapters exposing native promises to Gleam. Package `1.0.11`, JavaScript target, Gleam `>=1.11.0`; permits `gleam_javascript >=0.11.0 and <2.0.0`, locks `1.0.0` and stdlib `0.70.0`. [Configuration][weapp-config], [lockfile][weapp-lock]. |
| `kaiwu/wechat_dev_tools` — `11a11a2cf12c747697b26bca8dd12c3e419500e2` | A build application composing promise-returning esbuild adapters. Package `1.0.2`, JavaScript target, Gleam `>=1.14.0`; same JavaScript dependency range, locks `gleam_javascript 1.0.0`, stdlib `0.70.0`, and `weapp 1.0.8`. This consumer does **not** lock the inspected weapp HEAD. [Configuration][tools-config], [lockfile][tools-lock]. |
| `Enderchief/esgleam` — `79fff588156d849969d31523b8e5f992174a9cf1` | Promises hidden in JavaScript installer FFI, with callback completion and a separate synchronous subprocess bridge. Package `1.0.0`, JavaScript default, Gleam `>=1.12.0`; **no `gleam_javascript` dependency or Promise import**. Locks stdlib `0.65.0`, simplifile `2.3.1`, and gleam_regexp `1.1.1`. [Configuration][es-config], [lockfile][es-lock]. |
| `gleam-lang/stdlib` — `9816c72d28ac1fad9433e1ae851d1a3d4a17c64d` | Incidental runtime recognition of Promise objects for dictionary hashing; not an asynchronous API or orchestration example. Package `1.0.5`, Gleam `>=1.14.0`. [Configuration][stdlib-config], [hashing][stdlib-hash]. |

These are distinct uses. A search hit for `Promise` does not establish that a repository exposes the Gleam promise library: esgleam and stdlib illustrate why the FFI and actual imports matter.

## weapp: callback adaptation, typed outcomes, and native task handles

**Observation.** Current SDK modules import `gleam/javascript/promise.{type Promise}`. `WechatResult` aliases `Result(JsObject, WechatError)`; errors distinguish a string host error, decoding failures, and a Nil error. The normal network adapter allocates `new Promise`, resolves `Ok(res)` from `success`, and resolves `Error(WechatError(err.errMsg))` from `fail`. Host failure is therefore a **fulfilled promise carrying Error**, rather than JavaScript rejection. The `complete` callback is forwarded separately. [Types][weapp-types], [Gleam request API][weapp-request-api], [request FFI][weapp-request-ffi].

The FFI returns an ordinary native Promise. Its Gleam type annotation does not create an extra runtime container or guarantee that rejection is impossible. `util.flatten` unifies an immediate typed error with a future typed outcome by returning the existing promise on `Ok` and `promise.resolve(Error(...))` on `Error`. This is a useful composition pattern when validation precedes starting an asynchronous operation. [Utility source][weapp-util].

**Observation.** Newer request, download, and upload variants return a tuple containing the native task handle and the outcome promise. `taskResult` captures the handle synchronously while its Promise executor starts the operation. The Gleam docs explicitly direct callers to use the first tuple element for progress/abort and await the second for completion. [Download API][weapp-download-api], [request API][weapp-request-api], [upload API][weapp-upload-api], [task helper][weapp-task-helper].

**Transferable inference.** Keep the operation's control handle alongside its eventual result when cancellation or progress exists. A Promise by itself does not retain this SDK interface. Keep repeatable events as callbacks/subscriptions: socket `on_*`/`off_*` functions remain separate from one-shot connection/send results. Unhandled-rejection hooks are also exposed as native event registration/removal, not as automatic recovery for SDK calls. [Socket lifecycle][weapp-sockets], [rejection registration][weapp-rejection-on], [removal][weapp-rejection-off].

### What to harden before copying

1. **Settlement must actually happen.** Twenty-one UI wrappers, including `showModal`, `showActionSheet`, and `hideToast`, construct a Promise but never invoke `resolve` or `reject`; they only forward `complete`. Successful completion of that callback therefore leaves the returned promise pending. The first three Gleam APIs nevertheless declare `Promise(WechatResult)`. This is an observed FFI defect, not a recommended callback-to-promise pattern. [UI FFI, lines 4–242][weapp-ui-ffi], [declared API][weapp-ui-api].
2. **Define the completion milestone.** `set_data` calls `p.setData(d, f)` and immediately resolves `Ok(p.data)`. Awaiting this promise does not await the supplied callback. By comparison, `selector_query_exec` resolves *inside* the native `exec` callback. Do not infer rendering or host completion merely from a Promise return type. [set_data FFI][weapp-set-data], [declared API][weapp-page-api], [selector FFI][weapp-selector].
3. **Typed errors do not cover every native failure.** The normal network adapter has no `try`/`catch` converting a synchronous native throw into `WechatError`; a throw during the Promise executor produces native rejection. Exceptions in a later host callback are also outside that executor's synchronous call. A boundary intended to always fulfill with Result needs an explicit policy for these paths. [Request FFI][weapp-request-ffi].
4. **Raw payloads remain raw.** Success carries `JsObject`; useful domain types require decoding. `object.field` runs a supplied decoder and maps decoding failures to `WechatDecodeError`, which is a better boundary to build on than assuming SDK fields exist. [Decoder boundary][weapp-decode].
5. **Discarding is not observing.** `util.drain` simply returns Nil for any supplied value. `util.ignore` creates a fresh successful promise. Neither function attaches a rejection handler to an existing promise or waits for it, despite comments that might suggest draining work. [Utility source][weapp-util].

**Test evidence.** The network tests are explicitly placeholders that bind function values; they do not invoke callbacks or await outcomes. A separate native regression test verifies synchronous selector callback ordering, but exercises the callback variant rather than Promise settlement. The workflow runs `gleam test`; it does not explicitly invoke that Node regression file. These sources cannot substantiate complete asynchronous error/lifecycle coverage. [Network tests][weapp-network-tests], [native regression][weapp-native-tests], [workflow][weapp-ci].

## wechat_dev_tools: parallel assets inside sequential build phases

**Observation.** All eight build/watch FFI declarations return `Promise(Result(Nil, String))`; the `Builder` function alias lets an `Asset` select its implementation as data. The JavaScript adapters call esbuild and translate success into `Ok(undefined)` and rejection into a string-bearing Gleam Error. The checked-in npm lockfile pins esbuild `0.23.0` and esbuild-plugin-less `1.3.8`; package.json declares compatible ranges and a watch-mode environment variable. [Builder contract][tools-builders], [FFI][tools-ffi], [npm versions][tools-npm-lock], [scripts][tools-package].

`build` maps assets to started promises, awaits the list, then folds **all fulfilled Result values**, concatenating error messages. `main` awaits bundle, app, pages, and components in sequence, collects all four Result values, and prints combined errors. **Inference:** this expresses concurrent independent assets within each phase and ordered phase boundaries; a typed Error does not short-circuit later phases, because the continuation uses `promise.await`, not `result.try`. Unexpected native rejection still prevents the success continuation from reaching this Result fold. [Composition and error fold][tools-compose].

**Transferable inference.** Separate asynchronous scheduling from typed failure aggregation. A batch of promises resolving to Result can collect multiple expected failures without stopping at the first one. Keep phase ordering visible where output dependencies require it; preserve a named builder contract instead of scattering FFI decisions throughout the build traversal. [Asset type][tools-builders], [composition][tools-compose].

**What not to imitate.** Each watch callback calls `ctx.watch()` without returning or awaiting its promise, then a subsequent `.then` resolves the outer operation successfully. Thus the outer result covers context creation and calling `watch`, not successful watch setup; a rejected watch promise escapes that `.catch`. The context is not returned or disposed, so the caller also lacks an explicit shutdown handle. All four watch adapters repeat this shape. [Watch FFI][tools-watch]. The extra `new Promise(resolve => ...)` around an existing promise chain also complicates exceptional paths: an exception in the terminal rejection-conversion callback cannot reject the outer promise through a missing reject function. Prefer a directly returned chain with an explicit conversion policy; this is an inference from the adapter structure, not a patch applied here. [Build FFI][tools-ffi].

**Test evidence.** The sole test only checks that `1 == 1`; it does not establish ordering, aggregation, rejection conversion, watch readiness, or disposal. [Test file][tools-tests].

## esgleam: asynchronous FFI hidden behind Nil

**Observation.** The JavaScript installer `do_fetch` is an `async function`: it awaits fetch, streams through gzip/tar entries, creates a directory, writes the executable, applies permissions, then invokes a success callback. The source pins the downloaded esbuild tarball to `0.27.0`. This is JavaScript async/await inside FFI, not current usage of `gleam/javascript/promise`. [JavaScript installer][es-ffi], [target-specific declarations][es-install].

The JavaScript Gleam declaration says `do_fetch(..., then: fn() -> Nil) -> Nil`, although its native function returns a Promise. `internal_fetch` launches that callback path and returns Nil. The CLI install module invokes `internal_fetch`. The distinct public `fetch` function instead maps to JavaScript `install()`, which synchronously spawns `gleam run --target=erlang -m esgleam/install`; the Erlang implementation performs HTTP/tar extraction before returning. [Gleam installer][es-install], [CLI entry][es-cli], [subprocess bridge][es-bridge], [Erlang installer][es-erlang].

**Inference and caution.** This is a useful example of target-specific implementation choices, but a poor template for typed asynchronous completion: the Gleam caller cannot await, compose, cancel, or handle the hidden native rejection through its declared return type. The only catch in `do_fetch` ignores directory-creation failures; fetch, decompression, writing, chmod, and callback exceptions have no terminal rejection conversion. The callback runs after the loop even if no matching executable was found, and HTTP status is not checked. Treat the callback as the source's actual completion signal, not proof that installation succeeded. [Installer FFI][es-ffi]. The synchronous bridge also ignores the result from `spawnSync`, so a Nil return is not a checked subprocess success. [Bridge][es-bridge].

The vendored, minified streaming-tar implementation uses a deferred Promise to pause entry iteration until the current entry body is consumed, exposing `skip` and `arrayBuffer`. **Inference:** a future installer that ignores nonmatching entries should explicitly consume/skip them; at this snapshot `do_fetch` has no such else branch. This is a conditional stream-lifecycle concern, not a verified failure with the published tarball. [Vendored stream implementation][es-tar], [consumer][es-ffi].

**Test evidence.** The repository contains no test directory in the inspected checkout. Its workflow still selects Gleam `0.32.0`, below the package's declared `>=1.12.0`, and runs `gleam test`. Treat that workflow as stale configuration, not evidence that the current installer and asynchronous failure paths pass. [Workflow][es-ci], [package requirement][es-config].

## stdlib: identity hashing is incidental Promise recognition

**Observation.** Dictionary `hashObject` checks for `Promise`, `WeakSet`, and `WeakMap` instances and hashes these by reference using a WeakMap plus an incrementing identifier. A custom prototype `hashCode` hook is consulted first. It does not await a Promise, inspect its result, or manage rejection. This belongs to JavaScript object interoperability, not Promise-based application architecture. **Inference:** the important transferable distinction is identity-bearing handles versus structural data; do not copy this `instanceof` branch as a general thenable decoder. [Reference identity allocation][stdlib-reference], [object classification][stdlib-hash].

The test harness separately uses native async functions, awaits each test's return value, catches failures, and uses `node:fs/promises` for discovery/file reading. That explains additional promise-related search hits but adds no public stdlib Promise API. No Promise-specific dictionary test was found in the inspected tests. [Harness][stdlib-tests].

## Verification performed

Inspected tracked Gleam modules, JavaScript/Erlang FFI, manifests, npm lockfile, relevant tests, and CI configuration; searched all source/tests for Promise imports, constructors, awaiting, chaining, and rejection handling. No dependencies were installed and no live WeChat, network download, or esbuild integration was executed.

An isolated Node `v26.13.1` probe loaded the actual FFI function bodies, replacing imports with small constructor/API stubs. Assertions confirmed: request failure fulfills with Error; synchronous native request throws reject; the task tuple preserves identity; set_data settles before its uncalled callback; all **21** identified UI wrappers stay pending after mocked complete callbacks; and bundle_watch fulfills with Ok while a mocked watch rejection reaches `unhandledRejection`. These probes corroborate source-level claims, not host-platform compatibility.

[weapp-config]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/gleam.toml#L1-L23
[weapp-lock]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/manifest.toml#L4-L15
[weapp-types]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/object.gleam#L33-L65
[weapp-request-api]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/network.gleam#L123-L155
[weapp-request-ffi]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat_network_ffi.mjs#L114-L145
[weapp-task-helper]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat_network_ffi.mjs#L1-L34
[weapp-download-api]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/network.gleam#L5-L31
[weapp-upload-api]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/network.gleam#L268-L282
[weapp-util]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/util.gleam#L1-L28
[weapp-sockets]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/network.gleam#L33-L90
[weapp-rejection-on]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/app_event.gleam#L49-L53
[weapp-rejection-off]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/base.gleam#L557-L561
[weapp-ui-ffi]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat_ui_ffi.mjs#L4-L242
[weapp-ui-api]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/ui.gleam#L5-L40
[weapp-set-data]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat_ffi.mjs#L24-L29
[weapp-page-api]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/page.gleam#L39-L47
[weapp-selector]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat_wxml_ffi.mjs#L24-L34
[weapp-decode]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/src/wechat/object.gleam#L209-L225
[weapp-network-tests]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/test/wechat/network_test.gleam#L1-L59
[weapp-native-tests]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/test/native_regression.mjs#L20-L29
[weapp-ci]: https://github.com/kaiwu/weapp/blob/f2b43770b8bf2cfd16ef7e5914f094d211cfcbfa/.github/workflows/test.yml#L14-L23
[tools-config]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/gleam.toml#L1-L24
[tools-lock]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/manifest.toml#L4-L18
[tools-builders]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/src/build.gleam#L1-L70
[tools-ffi]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/src/build_ffi.mjs#L1-L68
[tools-watch]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/src/build_ffi.mjs#L70-L145
[tools-compose]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/src/build.gleam#L220-L256
[tools-package]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/package.json#L1-L18
[tools-npm-lock]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/package-lock.json#L432-L482
[tools-tests]: https://github.com/kaiwu/wechat_dev_tools/blob/11a11a2cf12c747697b26bca8dd12c3e419500e2/test/wechat_dev_tools_test.gleam#L1-L12
[es-config]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/gleam.toml#L1-L20
[es-lock]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/manifest.toml#L4-L14
[es-install]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/src/esgleam/mod/install.gleam#L5-L53
[es-ffi]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/src/ffi_esgleam.mjs#L70-L95
[es-cli]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/src/esgleam/install.gleam#L1-L7
[es-bridge]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/src/ffi_esgleam.mjs#L97-L99
[es-erlang]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/src/ffi_esgleam.erl#L55-L69
[es-tar]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/src/streaming_tar.mjs#L1-L25
[es-ci]: https://github.com/Enderchief/esgleam/blob/79fff588156d849969d31523b8e5f992174a9cf1/.github/workflows/test.yml#L14-L23
[stdlib-config]: https://github.com/gleam-lang/stdlib/blob/9816c72d28ac1fad9433e1ae851d1a3d4a17c64d/gleam.toml#L1-L14
[stdlib-reference]: https://github.com/gleam-lang/stdlib/blob/9816c72d28ac1fad9433e1ae851d1a3d4a17c64d/src/dict.mjs#L10-L31
[stdlib-hash]: https://github.com/gleam-lang/stdlib/blob/9816c72d28ac1fad9433e1ae851d1a3d4a17c64d/src/dict.mjs#L83-L124
[stdlib-tests]: https://github.com/gleam-lang/stdlib/blob/9816c72d28ac1fad9433e1ae851d1a3d4a17c64d/test/gleeunit_ffi.mjs#L45-L100
