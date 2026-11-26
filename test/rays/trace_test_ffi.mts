// A fake of the Workers runtime's tracing API that records spans, so tests
// can check what `rays/trace` and `rays/worker` do with it.
//
// Spans nest through a stack rather than the runtime's async context, which
// is right for tests that run one request at a time.

import { resetTracing, useTracing } from "./trace_ffi.mts";
import type { Span, Tracing } from "./trace_ffi.mts";

type Attribute = string | number | boolean;

class FakeSpan implements Span {
  readonly isTraced = true;
  attributes: Record<string, Attribute> = {};
  status = "unset";
  exceptions: string[] = [];
  ended = false;

  name: string;
  parent: string;

  // Fields declared out here, as Node.js only strips types from TypeScript.
  constructor(name: string, parent: string) {
    this.name = name;
    this.parent = parent;
  }

  setAttributes(attributes: Record<string, Attribute | undefined>): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.attributes[key] = value;
    }
    return this;
  }

  recordException(exception: { message: string }): void {
    this.exceptions.push(exception.message);
  }

  setStatus(status: { code: string; message?: string }): this {
    // As the runtime does: "ok" is final.
    if (this.status === "ok") return this;
    this.status =
      status.code === "error" ? `error: ${status.message}` : status.code;
    return this;
  }

  updateName(name: string): this {
    this.name = name;
    return this;
  }

  spanContext() {
    return { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };
  }
}

let spans: FakeSpan[] = [];
let stack: FakeSpan[] = [];

const fake: Tracing = {
  enterSpan<T>(name: string, callback: (span: Span) => T): T {
    const span = new FakeSpan(name, stack.at(-1)?.name ?? "");
    spans.push(span);
    stack.push(span);
    const end = () => {
      span.ended = true;
      stack = stack.filter((open) => open !== span);
    };
    let result: T;
    try {
      result = callback(span);
    } catch (error) {
      end();
      throw error;
    }
    if (result instanceof Promise) {
      result.then(end, end);
    } else {
      end();
    }
    return result;
  },
  getActiveSpan: () => stack.at(-1),
};

// Run `run` with the fake installed, and a root span standing in for the
// one the runtime records for a request's handler. The fake is removed when
// `run` returns, or when the promise it returns settles, even if it fails.
export function traced<T>(run: () => T): T {
  spans = [new FakeSpan("fetch", "")];
  stack = [spans[0]!];
  useTracing(fake);
  let result: T;
  try {
    result = run();
  } catch (error) {
    resetTracing();
    throw error;
  }
  if (result instanceof Promise) return result.finally(resetTracing) as T;
  resetTracing();
  return result;
}

// Every span recorded since `traced` started, in the order they started, as
// #(name, parent, attributes, status, exceptions, ended). Attribute values
// are written as strings, so a test can tell `trace.int(1)` from
// `trace.string("1")`.
export function recorded(): [
  string,
  string,
  [string, string][],
  string,
  string[],
  boolean,
][] {
  return spans.map((span) => [
    span.name,
    span.parent,
    Object.entries(span.attributes).map(([key, value]) => [
      key,
      `${typeof value}:${value}`,
    ]),
    span.status,
    span.exceptions,
    span.ended,
  ]);
}
