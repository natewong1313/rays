# Gleam

Before writing, editing, refactoring, or generating Gleam code, including tests, examples, and snippets, read and apply [writing-gleam](.agents/skills/writing-gleam/SKILL.md).

When working with JavaScript promises in Gleam, including promise-based JavaScript/TypeScript FFI, read and apply [gleam-javascript-promises](.agents/skills/gleam-javascript-promises/SKILL.md).

# Testing

TypeScript tests use Vitest; don't use `node:test` or `node:assert`.

In `packages/core`, `packages/cli` and `packages/config`, a module's tests sit next to it: `src/build/migrations.ts` is tested by `src/build/migrations.test.ts`. The package's `test/` directory holds only what the tests share: fixture projects, helpers, global setup and stubs. Each build `tsconfig` excludes `src/**/*.test.ts`, so tests stay out of `dist`.

Tests that run in workerd through `@cloudflare/vitest-plugin` (`packages/integration-tests` and `examples/*`) test Gleam code, not a TypeScript module, so they stay in `test/` as `*.spec.ts`. Gleam tests stay in `test/`, where `gleam test` finds them.
