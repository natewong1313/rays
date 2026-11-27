// FFI shim for `rays/observability/trace`: the Workers runtime's tracing API, from
// `cloudflare:workers`, behind functions that do nothing until a Worker's
// entry module hands it over.
//
// This module doesn't import `cloudflare:workers` itself, so `gleam test`
// and code built for Node.js can still load it. Until `useTracing` is called,
// as in unit tests and `rays/worker/simulate`, spans are a placeholder whose
// methods do nothing, and callbacks still run.
//
// Which status a `Result` gives is decided in Gleam; these functions only
// call the runtime and read thrown errors.

type Attribute = string | number | boolean;

// A runtime `Span`, or `NOOP`. Typed structurally so this module doesn't
// depend on `@cloudflare/workers-types` declaring tracing.
export interface Span {
  readonly isTraced: boolean;
  setAttributes(attributes: Record<string, Attribute | undefined>): unknown;
  recordException(exception: {
    name?: string;
    message: string;
    stack?: string;
  }): void;
  setStatus(status: { code: "ok" | "error"; message?: string }): unknown;
  updateName(name: string): unknown;
  spanContext(): { traceId: string };
}

export interface Tracing {
  enterSpan<T>(name: string, callback: (span: Span) => T): T;
  getActiveSpan(): Span | undefined;
}

const NO_TRACE_ID = "00000000000000000000000000000000";

// Stands in for every span until the runtime's tracing API is available, and
// for the active span outside a request.
const NOOP: Span = {
  isTraced: false,
  setAttributes: () => NOOP,
  recordException: () => {},
  setStatus: () => NOOP,
  updateName: () => NOOP,
  spanContext: () => ({ traceId: NO_TRACE_ID }),
};

let tracing: Tracing | undefined;

// Called by entry modules with RPC methods or Durable Objects, with `tracing`
// from `cloudflare:workers`, and by a Worker on each request with
// `ctx.tracing`, which covers every other Worker.
// The runtime has one tracing object, so replacing it changes nothing. A
// runtime too old to have one, or a context from `rays/worker/simulate`,
// gives `undefined`, which is ignored.
export function useTracing(runtime: Tracing | undefined): undefined {
  if (runtime !== undefined) tracing = runtime;
}

// Forget the runtime's tracing API. Only for tests, which install a fake.
export function resetTracing(): undefined {
  tracing = undefined;
}

export function enterSpan<T>(
  name: string,
  attributes: [string, Attribute][],
  run: (span: Span) => T,
): T {
  if (tracing === undefined) return run(NOOP);
  return tracing.enterSpan(name, (span) => {
    setAttributes(span, attributes);
    return run(span);
  });
}

export function activeSpan(): Span {
  return tracing?.getActiveSpan() ?? NOOP;
}

export function setAttributes(
  span: Span,
  attributes: [string, Attribute][],
): Span {
  if (attributes.length > 0) span.setAttributes(Object.fromEntries(attributes));
  return span;
}

export function setStatusOk(span: Span): Span {
  span.setStatus({ code: "ok" });
  return span;
}

export function setStatusError(span: Span, message: string): Span {
  span.setStatus({ code: "error", message });
  return span;
}

export function updateName(span: Span, name: string): Span {
  span.updateName(name);
  return span;
}

export function traceId(span: Span): string {
  return span.spanContext().traceId;
}

// The properties of an error thrown by a Gleam `panic`, `todo`,
// `let assert`, or `assert`: which kind it is, and where in the code.
interface GleamError {
  gleam_error: string;
  module: string;
  function: string;
  file?: string;
  line: number;
}

function isGleamError(error: unknown): error is GleamError {
  return (
    error instanceof Error &&
    typeof (error as Partial<GleamError>).gleam_error === "string"
  );
}

// Where a Gleam error happened, as OpenTelemetry's `code.*` attributes.
function locationOf(error: GleamError): Record<string, Attribute | undefined> {
  return {
    "gleam.error": error.gleam_error,
    "code.function.name": `${error.module}.${error.function}`,
    "code.file.path": error.file || undefined,
    "code.line.number": error.line,
  };
}

// Record an error thrown while handling a request on `span`, and mark the
// span as failed. Never throws, since it runs while another error is on its
// way out.
export function recordThrown(span: Span, error: unknown): undefined {
  try {
    const message =
      error instanceof Error ? String(error.message) : String(error);
    span.recordException(
      error instanceof Error
        ? { name: String(error.name), message, stack: error.stack }
        : { message },
    );
    if (isGleamError(error)) span.setAttributes(locationOf(error));
    span.setStatus({ code: "error", message });
  } catch {
    // Tracing must never replace the error being reported.
  }
}

// Attribute values are the JavaScript values themselves: Gleam's strings,
// ints, floats, and bools are already strings, numbers, and booleans.
export function attribute(value: Attribute): Attribute {
  return value;
}
