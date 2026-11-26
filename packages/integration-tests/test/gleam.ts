// The compiled Gleam modules the tests call, and helpers for their values.
// The tests run in workerd, in the same isolate as the Worker, so they call
// rays's API directly, as Gleam code in the Worker would.

import { exports } from "cloudflare:workers";
import { Result$isOk, Result$Ok$0 } from "../build/dev/javascript/prelude.mjs";
import { inspect } from "../build/dev/javascript/gleam_stdlib/gleam/string.mjs";
import * as durableObject from "../build/dev/javascript/rays/rays/durable_object.mjs";

export { durableObject, inspect };
export * as counter from "../build/dev/javascript/integration_tests/integration_tests/counter.mjs";
export * as sleepy from "../build/dev/javascript/integration_tests/integration_tests/sleepy.mjs";

/** The value of an `Ok`, or a failed test for an `Error`. */
export function unwrap<T>(result: unknown): T {
  if (!Result$isOk(result)) {
    throw new Error(`expected Ok, got ${inspect(result)}`);
  }
  return Result$Ok$0(result as never) as T;
}

/** The runtime's stub that a `Stub` sends its next call through. */
export function runtimeStub(stub: unknown): DurableObjectStub {
  return (stub as { current(): DurableObjectStub }).current();
}

/** The namespace of a class this Worker exports, through `ctx.exports`. */
export function exported(
  classFunction: () => unknown,
): durableObject.Namespace$<unknown> {
  return unwrap(
    durableObject.exported({ exports } as never, classFunction as never),
  );
}
export * as notes from "../build/dev/javascript/integration_tests/integration_tests/notes.mjs";
export * as sqlCheck from "../build/dev/javascript/integration_tests/integration_tests/sql_check.mjs";
export * as reminders from "../build/dev/javascript/integration_tests/integration_tests/reminders.mjs";
