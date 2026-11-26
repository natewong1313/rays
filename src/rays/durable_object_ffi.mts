// FFI shim for `rays/durable_object`: Durable Object classes and their
// memory, the instances the generated entry module creates, and the
// namespaces, ids and stubs used to call them.
//
// Calls go through `rays/worker_rpc`'s codec and registry, so a method's
// arguments and reply are encoded the same way as for Workers RPC, and a
// stub is called with its `callWith`. The registry also holds the classes,
// which the footers of the modules that define them register.

import { Result$Error, Result$Ok } from "../gleam.mjs";
import type { Result } from "../gleam.mjs";
import {
  callWith,
  checkMethods,
  registeredClass,
  registeredClassName,
  serveMethods,
  type Call,
  type ClassFunction,
  type Failure,
  type FailureKind,
  type MethodFunction,
  type Reply,
  type Service,
} from "./worker_rpc_ffi.mts";
import type { Env } from "./worker_ffi.mts";
import {
  checkAlarms,
  rememberInstance,
  type AlarmConfig,
  type AlarmFunction,
} from "./durable_object/alarm_ffi.mts";

// Entry modules with Durable Objects hand the runtime's tracing API to
// `rays/trace` through this module, which they import anyway, and each
// class's `alarm` method runs its alarms with `runAlarms`.
export { useTracing } from "./trace_ffi.mts";
export { runAlarms } from "./durable_object/alarm_ffi.mts";

// Classes

type Handler = (
  args: unknown,
  env: Env,
  ctx: DurableObjectState,
  memory: Memory,
) => Promise<unknown>;

const DEFINITION = Symbol.for("rays.durable_object");

type Wake = (env: Env, ctx: DurableObjectState, memory: Memory) => undefined;

// What `new`, `on_wake`, `bind` and `register_alarm` build: a class's
// starting memory, wake function, methods and alarm handlers. The generated
// entry module makes a `DurableObject` class from it.
export interface Definition {
  readonly [DEFINITION]: true;
  readonly memory: unknown;
  readonly wake: Wake | undefined;
  readonly methods: ReadonlyMap<MethodFunction, Handler>;
  readonly alarms: ReadonlyMap<AlarmFunction, AlarmConfig>;
}

export function newObject(memory: unknown): Definition {
  return {
    [DEFINITION]: true,
    memory,
    wake: undefined,
    methods: new Map(),
    alarms: new Map(),
  };
}

export function onWake(definition: Definition, wake: Wake): Definition {
  return { ...definition, wake };
}

export function bind(
  definition: Definition,
  method: MethodFunction,
  handler: Handler,
): Definition {
  const methods = new Map(definition.methods);
  methods.set(method, handler);
  return { ...definition, methods };
}

// Memory

// A mutable cell, so `update_memory` changes what every later call reads.
// Named `Memory` so that the codec's error for one sent over RPC reads "a
// Memory can't be sent over RPC".
class Memory {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

export function updateMemory(
  memory: Memory,
  update: (value: unknown) => unknown,
): unknown {
  // Set only once the update returns, so a panic leaves the memory alone.
  const updated = update(memory.value);
  memory.value = updated;
  return updated;
}

export function readMemory(memory: Memory): unknown {
  return memory.value;
}

// Instances
//
// The generated entry module exports one `DurableObject` class per class
// definition. Its constructor calls `wakeObject` and keeps the memory it
// returns, and each of its methods calls `serveObject` with that memory.

// Check, when the Worker starts, that the class's function is registered
// and returned a `DurableObject`, and that rays found every method bound to
// it. The generated entry module calls this once per class, after importing
// the module whose footer registers it.
export function checkObject(className: string, source: string): Definition {
  const classFunction = registeredClass(className);
  if (classFunction === undefined) {
    throw new TypeError(
      `${source} isn't registered as the class ${className}. Rebuild the Worker with rays.`,
    );
  }
  const definition = classFunction();
  if (
    typeof definition !== "object" ||
    definition === null ||
    (definition as Record<symbol, unknown>)[DEFINITION] !== true
  ) {
    throw new TypeError(
      `${source} must return a rays DurableObject, made with durable_object.new, to be the class ${className}.`,
    );
  }
  const checked = definition as Definition;
  checkMethods(
    checked.methods.keys(),
    `durable_object.bind was given a function that isn't an RPC method, for the class ${className}. A method must be a public function in this package whose only argument is a durable_object.Params.`,
  );
  checkAlarms(checked, className);
  return checked;
}

// Wake a new instance, from its class's constructor: set its memory, and
// run `on_wake`. Both happen before the runtime delivers any call, as does
// a `lock` that `on_wake` takes. If `on_wake` panics, the constructor
// throws, and the runtime resets the instance.
export function wakeObject(
  definition: Definition,
  ctx: DurableObjectState,
  env: Env,
): Memory {
  const memory = new Memory(definition.memory);
  // Before on_wake, which can schedule alarms.
  rememberInstance(definition, ctx, env, memory);
  definition.wake?.(env, ctx, memory);
  return memory;
}

export function serveObject(
  definition: Definition,
  memory: Memory,
  name: string,
  call: Call,
  env: Env,
  ctx: DurableObjectState,
): Promise<Reply> {
  return serveMethods(definition.methods, name, call, (handler, args) =>
    handler(args, env, ctx, memory),
  );
}

// Context

export function contextId(ctx: DurableObjectState): DurableObjectId {
  return ctx.id;
}

export function waitUntil(
  ctx: DurableObjectState,
  promise: Promise<unknown>,
): undefined {
  ctx.waitUntil(promise);
  return undefined;
}

// Released when the function's promise settles: the runtime only lets
// through events that the function's own code started, so there can't be a
// separate unlock. If it rejects or times out, the runtime resets the
// instance, and the returned promise rejects.
export function lock<A>(
  ctx: DurableObjectState,
  locked: () => Promise<A>,
): Promise<A> {
  return ctx.blockConcurrencyWhile(locked);
}

// Namespaces
//
// A namespace is the binding with a location hint, which the runtime takes
// when a stub is made rather than as part of the namespace.

class Namespace {
  readonly binding: DurableObjectNamespace;
  readonly hint: string | undefined;
  constructor(binding: DurableObjectNamespace, hint: string | undefined) {
    this.binding = binding;
    this.hint = hint;
  }
}

// Bindings are objects, but a namespace in `ctx.exports` can be callable.
function isNamespace(value: unknown): value is DurableObjectNamespace {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === "function"
  );
}

export function namespace(binding: unknown): Result<Namespace, undefined> {
  return isNamespace(binding)
    ? Result$Ok(new Namespace(binding, undefined))
    : Result$Error(undefined);
}

export function exported(
  ctx: ExecutionContext,
  classFunction: ClassFunction,
): Result<Namespace, undefined> {
  const name = registeredClassName(classFunction);
  if (name === undefined) return Result$Error(undefined);
  const exports = (ctx as { exports?: Record<string, unknown> }).exports;
  const binding = exports?.[name];
  return isNamespace(binding)
    ? Result$Ok(new Namespace(binding, undefined))
    : Result$Error(undefined);
}

export function jurisdiction(
  namespace: Namespace,
  jurisdiction: DurableObjectJurisdiction,
): Namespace {
  return new Namespace(
    namespace.binding.jurisdiction(jurisdiction),
    namespace.hint,
  );
}

export function locationHint(namespace: Namespace, hint: string): Namespace {
  return new Namespace(namespace.binding, hint);
}

function stubOptions(
  namespace: Namespace,
): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  return namespace.hint === undefined
    ? undefined
    : {
        locationHint:
          namespace.hint as DurableObjectNamespaceGetDurableObjectOptions["locationHint"],
      };
}

// Stubs
//
// Many exceptions leave a runtime stub broken: every later call through it
// fails at once with the same exception, even after the instance has woken
// again. So a `Stub` keeps the means to make its runtime stub, and replaces
// it on the next call after a send throws. The failed call isn't retried,
// since only its caller knows whether that is safe; the runtime already
// retries calls that never reached the instance.
//
// Only a send that throws breaks a stub. A method's own errors and panics
// come back in its reply, and leave the stub as it was.
class Stub {
  readonly #make: () => DurableObjectStub;
  #current: DurableObjectStub;
  #broken = false;
  constructor(make: () => DurableObjectStub) {
    this.#make = make;
    this.#current = make();
  }

  // The runtime stub to send the next call through.
  current(): DurableObjectStub {
    if (this.#broken) {
      this.#current = this.#make();
      this.#broken = false;
    }
    return this.#current;
  }

  // Replace `sent` before the next call, unless a call that failed earlier
  // already has: calls in flight on a broken stub all fail, and only the
  // first should make a new one.
  breakIfCurrent(sent: DurableObjectStub): void {
    if (this.#current === sent) this.#broken = true;
  }
}

export function getByName(namespace: Namespace, name: string): Stub {
  const options = stubOptions(namespace);
  return new Stub(() => namespace.binding.getByName(name, options));
}

export function get(namespace: Namespace, id: DurableObjectId): Stub {
  const options = stubOptions(namespace);
  return new Stub(() => namespace.binding.get(id, options));
}

// Ids

export function newUniqueId(namespace: Namespace): DurableObjectId {
  return namespace.binding.newUniqueId();
}

export function idFromName(
  namespace: Namespace,
  name: string,
): DurableObjectId {
  return namespace.binding.idFromName(name);
}

export function idFromString(
  namespace: Namespace,
  id: string,
): Result<DurableObjectId, undefined> {
  try {
    return Result$Ok(namespace.binding.idFromString(id));
  } catch {
    return Result$Error(undefined);
  }
}

export function idToString(id: DurableObjectId): string {
  return id.toString();
}

export function idName(id: DurableObjectId): Result<string, undefined> {
  return typeof id.name === "string"
    ? Result$Ok(id.name)
    : Result$Error(undefined);
}

// Calls

// The failures only a Durable Object has, besides those of Workers RPC.
type ObjectFailureKind = "reset" | "overloaded" | "retryable";

export function call(
  stub: Stub,
  method: MethodFunction,
  args: unknown,
): Promise<Result<unknown, Failure<ObjectFailureKind | FailureKind>>> {
  const sent = stub.current();
  // `callWith` asks for the kind of failure only when the send throws.
  return callWith(sent as unknown as Service, method, args, (error) => {
    stub.breakIfCurrent(sent);
    return sendFailure(error);
  });
}

// The kind of failure an exception from a Durable Object is. Its exceptions
// say whether the instance was reset, whether it was overloaded, and whether
// the call is safe to retry. A reset is checked first: one caused by a lock
// that timed out is also marked overloaded.
function sendFailure(error: unknown): ObjectFailureKind | "send" {
  if (typeof error !== "object" || error === null) return "send";
  const flags = error as {
    durableObjectReset?: unknown;
    overloaded?: unknown;
    retryable?: unknown;
  };
  if (flags.durableObjectReset === true) return "reset";
  if (flags.overloaded === true) return "overloaded";
  if (flags.retryable === true) return "retryable";
  return "send";
}
