# Architecture patterns and study sources

Consult the section matching the work. These are patterns to select from, rather than a required stack or project template.

## Public facade and implementation modules

Mist, birdie, and squirrel keep the user-facing surface narrow and give implementation concerns their own modules:

```text
src/package.gleam
src/package/internal/error.gleam
src/package/internal/parser.gleam
src/package/internal/protocol/frame.gleam
test/package/parser_test.gleam
examples/complete/gleam.toml
examples/complete/src/complete.gleam
```

Use a public submodule when a concept has its own audience, such as glint's constraints or gleam_http's request and response types. Lustre names larger architecture layers (`vdom`, `runtime`) and lists their patterns in `internal_modules`:

```toml
internal_modules = ["lustre/internals/*", "lustre/vdom/*", "lustre/runtime/*"]
```

Select patterns for the actual package; this setting controls the documentation surface. A private or opaque type controls what callers can construct. Keep source and tests aligned by responsibility; introduce unit/integration/snapshot layers when the package needs them.

Snag, glance, and simplifile demonstrate that one cohesive public module can be enough. Wisp uses sections for responses, requests, and cookies inside its public module. File size alone is a weak reason to split a concept that callers use together.

## Actors and protocols: gleam_otp and mist

For BEAM actor work, model interactions as a message ADT. Request variants carry a typed reply channel; fire-and-forget variants carry only their input. An excerpt from the studied OTP stack example, with its import:

```gleam
import gleam/erlang/process.{type Subject}

pub type Message(element) {
  Shutdown
  Push(push: element)
  Pop(reply_with: Subject(Result(element, Nil)))
}
```

Return an explicit next-step value describing new state and continuation or termination. Keep state and message parameters independent when the protocol needs it. Wrap raw subjects and protocol messages behind typed operations such as `start`, `push`, and `pop`; make request timeouts explicit.

Follow the installed OTP package's builder and supervision APIs. Its module docs use a complete worked program to teach the message → handler → reply model. This is a runtime-specific pattern: select libraries supported by the project's target.

## Frameworks and effects: lustre

When working in an MVU framework, keep `Model` and `Message` as data, make `update` describe the new model and effects, and let the runtime execute those effects. Lustre's update shape is `fn(Model, Message) -> #(Model, Effect(Message))`.

Pass application behavior as labelled function values (`init:`, `update:`, `view:`). Generic `Element(message)` and `Effect(message)` keep a program's messages consistent through the framework. A tag or attribute DSL can be a vocabulary of small typed functions, as in `html.div`, `svg.circle`, and `attribute.class`.

Use framework module docs to explain the architecture, including a small diagram when it clarifies data flow. A pure data library such as gleam_http should remain usable without a particular runtime or IO implementation; choose that boundary deliberately when designing shared types.

## CLIs and diagnostics: squirrel and birdie

Parse raw arguments into a command ADT once. Let the entrypoint read as an orchestration outline: parse, prepare, execute, report. Keep domain work in focused modules and put printing and exit codes at the edge.

Co-locate an error ADT and its exhaustive renderer when that keeps the diagnostic contract clear; keep operational modules concerned with producing typed errors. Carry the context needed for actionable messages in the error values. Use the project's existing pretty-printing tools for help and diagnostics.

Squirrel favors documented discovery conventions over extra configuration. Apply that choice when a predictable project layout covers the use case. Snapshot generated code and diagnostic text when exact output is part of the contract, as squirrel and birdie do.

## FFI and target boundaries: simplifile

Keep foreign operations behind small Gleam functions with a consistent typed API. Map foreign errors into the exposed taxonomy; preserve an unknown case where the foreign error space is open. Put domain decisions in Gleam and keep shims focused on runtime conversion.

Respect the targets declared by the project. A cross-target library can have target-specific implementations behind one public API; a target-specific application can use its runtime directly. Check FFI conversion, error handling, and any promised normalization on the relevant target rather than assuming type checking proves runtime compatibility.

## Study provenance

The skill was distilled from all twelve Markdown studies and their README synthesis in `rays/docs`. The table identifies the upstream projects studied; it is a source index, not an instruction to install their packages or fetch all their code.

| Study | Upstream project | Distinctive evidence |
| --- | --- | --- |
| `gleam_stdlib.md` | [gleam-lang/stdlib](https://github.com/gleam-lang/stdlib) | Result/Option distinction, labelled functions, concept modules. |
| `gleam_http.md` | [gleam-lang/http](https://github.com/gleam-lang/http) | Payload-generic records, fallible sequencing, normalizing setters. |
| `gleam_otp.md` | [gleam-lang/otp](https://github.com/gleam-lang/otp) | Typed messages and reply channels, next-step values, teaching docs. |
| `wisp.md` | [gleam-wisp/wisp](https://github.com/gleam-wisp/wisp) | Domain aliases, variant and field documentation, sectioned API. |
| `mist.md` | [rawhat/mist](https://github.com/rawhat/mist) | Facade and internals, opaque protocol types, standalone examples. |
| `lustre.md` | [lustre-labs/lustre](https://github.com/lustre-labs/lustre) | Named architecture layers, effects, labelled callbacks, DSL modules. |
| `squirrel.md` | [giacomocavalieri/squirrel](https://github.com/giacomocavalieri/squirrel) | CLI orchestration, rich error values and rendering, codegen snapshots. |
| `birdie.md` | [giacomocavalieri/birdie](https://github.com/giacomocavalieri/birdie) | Infrastructure error wrapping, command ADTs, explicit imports. |
| `glance.md` | [lpil/glance](https://github.com/lpil/glance) | Generic AST wrappers, local aliases, domain vocabulary. |
| `snag.md` | [gleam-experiments/snag](https://github.com/gleam-experiments/snag) | Contextual errors for reporting layers, small cohesive scope. |
| `simplifile.md` | [bcpeinhardt/simplifile](https://github.com/bcpeinhardt/simplifile) | Foreign error taxonomy, unknown errors, thin cross-target wrappers. |
| `glint.md` | [TanklesXL/glint](https://github.com/TanklesXL/glint) | Configuration functions, nested updates, centralized defaults. |
