# Gleam

Before writing, editing, refactoring, or generating Gleam code, including tests, examples, and snippets, read and apply [writing-gleam](.agents/skills/writing-gleam/SKILL.md).

When working with JavaScript promises in Gleam, including promise-based JavaScript/TypeScript FFI, read and apply [gleam-javascript-promises](.agents/skills/gleam-javascript-promises/SKILL.md).

# Testing

TypeScript tests use Vitest; don't use `node:test` or `node:assert`.

For property-based tests, import `it` and `fc` from `@fast-check/vitest` (it is Vitest's `it`, plus `it.prop`), and `describe` and `expect` from `vitest`. Write a few example tests first, as documentation, then properties for what should always or never hold. Build inputs whose expected result you know rather than re-implementing the code under test, and don't constrain arbitraries beyond what the code requires. When a set of inputs is small enough to list, such as every ASCII character, test them all with `it.each` instead: a property draws only 100 of them per run.

In `packages/core`, `packages/cli` and `packages/config`, a module's tests sit next to it: `src/build/migrations.ts` is tested by `src/build/migrations.test.ts`. The package's `test/` directory holds only what the tests share: fixture projects, helpers, global setup and stubs. Each build `tsconfig` excludes `src/**/*.test.ts`, so tests stay out of `dist`.

Tests that run in workerd through `@cloudflare/vitest-plugin` (`packages/integration-tests` and `examples/*`) test Gleam code, not a TypeScript module, so they stay in `test/` as `*.spec.ts`. Gleam tests stay in `test/`, where `gleam test` finds them.
