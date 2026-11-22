---
name: writing-gleam
description: "Gleam coding conventions. Use before writing, editing, refactoring, or generating Gleam code, including .gleam files, tests, examples, and snippets, even when the task does not explicitly name the language. Distilled from twelve ecosystem repository studies and the official Gleam conventions guide."
---

# Writing Gleam

Write Gleam as typed data composed through small functions. These are ecosystem defaults distilled from the twelve studies and synthesis in `rays/docs`, plus the official [conventions, patterns, and anti-patterns](https://gleam.run/documentation/conventions-patterns-and-anti-patterns/) guide; explicit user choices and established project conventions take precedence.

## Before the first edit

1. Read the applicable repository instructions, `gleam.toml`, and the neighboring source and tests. Identify the target runtime, available dependencies, public API conventions, and validation commands before choosing an implementation.
2. Decide which module owns the change, which inputs need parsing, and which failures callers need to distinguish. Keep existing public contracts unless the task calls for changing them.
3. For new or redesigned types, errors, or configuration APIs, consult the relevant examples in [patterns.md](references/patterns.md). For module boundaries, actors, frameworks, CLIs, API clients, or FFI, read the matching section of [architecture.md](references/architecture.md). Ordinary local edits can use the rules below directly.

## Model data and failure

- Return `Result(value, error)` for fallible operations, including lookups and parsing. Use `Result(a, Nil)` when failure has no useful detail. Reserve `Option(a)` for optional arguments and stored data.
- Parse external inputs into domain types at the boundary; use exhaustive `case` expressions on those types inside the program. List every variant of your own types explicitly so a new variant surfaces as a compile error at each site that must handle it; keep `_` for open types such as `String` and `Int`.
- Make invalid states unrepresentable: give each distinct state its own variant carrying exactly the data it needs (`LoggedInUser(id:, email:)` | `Guest`) rather than a record of independent optional fields. Model a two-way choice as a named custom type (`role: Role` with `Student` | `Teacher`) rather than a `Bool`.
- Choose errors by what their consumer does. Use documented error ADTs when callers branch or diagnostics need structured context. A context-bearing generic error suits an outer layer that only reports failure; a CLI can still benefit from a custom ADT.
- Name domain error variants after failed operations in the business domain (`NoteCouldNotBeRead`), not after the dependency that failed (`FileError`). Retain the underlying typed error in `reason:` and useful context in fields such as `source:`, `destination:`, or `title:`. Keep error construction separate from rendering and printing.
- At an open external boundary, retain unmapped failures with a variant such as `Unknown(inner: String)`. For a closed domain, enumerate its actual cases.
- Expose `pub type` records and variants when callers should construct or inspect them. Use `pub opaque type` with constructor functions when construction must preserve invariants or representation should stay private.
- Parameterize repeated structure by its varying payload, as in `Request(body)` or `Definition(a)`. Use domain aliases to specialize generic library types and private aliases to simplify repeated local shapes.
- Use tuples for lightweight pairs; introduce a named record when grouped values have a domain identity, as with `Span(start:, end:)`.

## Shape the API around composition

- Put the value being transformed first so calls compose with `|>`. Add argument labels where they clarify public multi-argument calls, especially callbacks such as `with:`, `init:`, `update:`, and `view:`.
- Annotate every module function's argument types and return type, public or private.
- Start with a useful default and refine it through small functions. Follow the surrounding API's `set_*` vocabulary for record operations or `with_*` / `without_*` for configuration. Keep defaults in one definition and document them on the relevant operations.
- Express changes as record updates: `Request(..request, headers:)`. Nested configuration can use nested record updates; constructors and setters normalize inputs when the API promises an invariant.
- Accept ordinary function values for supplied behavior. An API client is the exception: keep IO with the caller through the sans-io pattern in [architecture.md](references/architecture.md), since a send-function parameter ties the library to one client and one target's promise types.
- Build on the core-team packages (`gleam_stdlib`, `gleam_time`, `gleam_json`, `gleam_http`, `gleam_erlang`, `gleam_otp`, `gleam_javascript`) and reuse their types, such as `gleam_time`'s `Timestamp`. Compose existing typed library interfaces and keep domain wrappers thin; adding a dependency should serve the requested change.
- Write concrete functions over concrete types (`int.sum(costs)`); Gleam lacks the ergonomics that make category-theory abstractions such as monoids worthwhile.

## Write expressions and names idiomatically

- Chain sequential fallible steps with `use value <- result.try(...)`; convert errors with `result.map_error` at the boundary where their meaning changes. Use `case` when branches have different behavior.
- Check and extract a value in one step with `case` or `result.try`. A predicate such as `result.is_ok` followed by `let assert` on the same value is the shape to rewrite.
- Handle expected runtime failures explicitly. Library code returns `Result` and stays free of `panic` and `let assert`, since only the caller knows how failure should be handled; OTP code designed around supervision is the exception. Reserve `let assert` for tests, examples, dev scripts, and application entrypoints.
- Use pipelines for a readable sequence of transformations, small helpers for named operations, and private tail-recursive `*_loop` helpers when recursion makes iteration clearer. Accumulate lists with `[item, ..items]` and reverse once when order requires it.
- Use `snake_case` for modules, functions, variables, and constants; `CamelCase` for types and constructors. Prefer domain nouns for modules, verbs for actions, and `is_*` for predicates.
- Write names in full (`capacity`, `offset`, `session`). Short names suit generic type parameters (`a`, `e`) and tightly scoped callback arguments; otherwise name the role (`body`, `message`, `state`).
- Name modules in the singular at every path segment (`app/user`, `app/payment/invoice`). Treat acronyms as one word: `Json`, `build_json`, `HttpClient`.
- Name conversions `x_to_y` (`json_to_string`). Inside a module named for the type, drop the prefix (`identifier.to_string`). Prefer a format or operation name when one exists (`date_to_rfc3339`, `round`).
- Name fallible functions for the domain operation (`parse_json`, `enqueue`). Use the `try_` prefix for a `Result`-returning variant of an existing function (`try_map`) when no domain name fits.
- Import types explicitly with `type`; name the constructors used in construction or matching. Alias collisions at the import (`type Request as HttpRequest`). Keep ordinary function and constant references module-qualified.
- Use field shorthand when the local name matches the label, `_` for ignored values, and named `const`s for shared domain vocabulary. Let `gleam format` decide formatting.

## Keep structure proportional

- Keep a focused small package in one public module, and let a cohesive module grow large. Add modules for concepts that have their own responsibilities or audiences; module paths follow file paths. Import cycles, or a simple task needing many imports, signal modules that belong together.
- Draw module boundaries around the business domain and the API callers need (`app/stock`, `app/billing`), not around kinds of code such as `types`, `utils`, `errors`, or `services`.
- Place every module under `src/<package_name>/` beside `src/<package_name>.gleam`; BEAM module names are global, and other packages' top-level directories belong to those packages.
- As implementation grows, keep a narrow public facade and decompose internals by concern under the package namespace. Use `internal_modules` in `gleam.toml` for the intended documentation boundary; use type visibility and opacity for construction boundaries.
- Put shipped code in `src`, importing only dependencies and `src`. Put tests in `test` and development helpers such as code generators in `dev`; both may import anything, including dev-dependencies.
- Configure development tools in `gleam.toml` under `[tools.<tool_name>]` rather than a dedicated config file; take dynamic values from environment variables or arguments.
- Organize a large cohesive module by domain concern, with section comments when helpful. Mirror meaningful source boundaries in tests. Substantial executable examples can be standalone projects under `examples/`.

## Document and verify the change

- Add `///` documentation for new or changed public items, including meaningful variant and field documentation. State failure behavior, invariants, defaults, and performance consequences where callers encounter them. Use sentences ending in periods and concrete Gleam examples.
- Use `////` module docs to teach a new module's mental model. Scale the explanation to the audience: a focused description for a small utility, a complete walkthrough or architecture diagram for a framework.
- Comment code whose purpose or reasoning a future reader could not recover from the code alone, stating what it does and why, such as the compatibility case a branch exists for.
- Keep examples executable. Run doctests when the project has a doctest harness; otherwise compile or exercise meaningful examples through the existing test setup. A Markdown code fence alone does not execute an example.
- Test changed observable behavior and the relevant error cases with the project's existing conventions. Use snapshots for generated code or diagnostic output when that is the behavior under test.
- Before finishing, format changed Gleam files, run the project's build and relevant tests for its configured targets, and account for every changed public contract in docs and tests. Report any validation that could not run.
