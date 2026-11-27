// FFI shim for `rays/worker_rpc`: the registry the build fills in, the codec
// that turns Gleam values into data Workers RPC can copy, and both ends of a
// call.
//
// Workers RPC copies values with structured clone, which rejects instances of
// classes, and every Gleam custom type, list, bit array and dict is one. So
// values are encoded into tagged plain data, and decoded back into instances
// of the same classes on the other side. That needs each class to be found
// again by name, which is what the registry is for: `rays build` appends a
// footer to every compiled Gleam module that registers its custom types and
// RPC methods. See docs/RPC-CODEC.md in the rays repository.
//
// Decisions such as how an outcome maps onto `CallError` are made in Gleam;
// this file only moves values across the boundary.

import {
  BitArray$BitArray,
  BitArray$isBitArray,
  CustomType,
  List$Empty,
  List$isEmpty,
  List$isNonEmpty,
  List$NonEmpty,
  List$NonEmpty$first,
  List$NonEmpty$rest,
  Result$Error,
  Result$Ok,
  UtfCodepoint,
} from "../gleam.mjs";
import type { BitArray, List, Result } from "../gleam.mjs";
// gleam_stdlib's modules sit next to this package's in the build directory,
// outside the directories TypeScript checks, so their types are given below.
// @ts-ignore
import Dict from "../../gleam_stdlib/dict.mjs";
// @ts-ignore
import * as gleamDict from "../../gleam_stdlib/gleam/dict.mjs";
import { currentEnv, describeError, useEnv } from "./worker_ffi.mts";
import type { Env, Worker } from "./worker_ffi.mts";

// Entry modules with RPC methods hand the runtime's tracing API to
// `rays/trace` through this module, which they import anyway.
export { useTracing } from "./trace_ffi.mts";

type GleamDict = { readonly __dict: unique symbol };

// Looked up when called rather than when this module is evaluated, in case
// that happens in the middle of an import cycle.
const dicts = () =>
  gleamDict as {
    fold<A>(
      dict: GleamDict,
      initial: A,
      fun: (acc: A, key: unknown, value: unknown) => A,
    ): A;
    insert(dict: GleamDict, key: unknown, value: unknown): GleamDict;
    new$(): GleamDict;
  };

// Registry
//
// Footers call `register` and `registerMethod` while their module is first
// evaluated, which can happen before this module has finished evaluating when
// the two import each other in a cycle. So the state lives on `globalThis`,
// created on first use, rather than in module-level constants that would
// still be uninitialized then.

type Constructor = new (...fields: unknown[]) => unknown;
export type MethodFunction = (params: unknown) => Promise<unknown>;

interface MethodInfo {
  readonly module: string;
  readonly name: string;
  readonly version: string;
}

interface Registry {
  readonly constructors: Map<string, Constructor>;
  readonly methods: Map<MethodFunction, MethodInfo>;
  // `rays/durable_object`'s classes, by the name of the class the entry
  // module exports: the function that defines each, and the other way
  // around. A module evaluated again, as in development, registers its new
  // function in its place, while code holding the old one still finds the
  // class's name.
  readonly classes: Map<string, ClassFunction>;
  readonly classNames: Map<ClassFunction, string>;
}

export type ClassFunction = () => unknown;

function registry(): Registry {
  const key = Symbol.for("rays.rpc.registry");
  const store = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (store[key] ??= {
    constructors: new Map(),
    methods: new Map(),
    classes: new Map(),
    classNames: new Map(),
  });
}

// The property a registered class's prototype holds its id in. A function,
// not a constant, for the same reason as `registry`.
function ID(): symbol {
  return Symbol.for("rays.rpc.id");
}

// Register the custom types defined in a compiled Gleam module, so they can
// be encoded and decoded. Classes that aren't custom types, such as an FFI
// module's own, are skipped.
export function register(module: string, classes: Record<string, unknown>) {
  const { constructors } = registry();
  for (const [name, value] of Object.entries(classes)) {
    if (typeof value !== "function") continue;
    if (!(value.prototype instanceof CustomType)) continue;
    const id = `${module}.${name}`;
    Object.defineProperty(value.prototype, ID(), { value: id });
    constructors.set(id, value as Constructor);
  }
}

// The prelude's own custom types, which have no footer: the prelude is a
// dependency of this module, so it can't import it back.
register("gleam", {
  Ok: Result$Ok(0).constructor,
  Error: Result$Error(0).constructor,
});

// Register an RPC method: a public function taking `worker_rpc.Params`.
// The version changes whenever the method's argument or reply types do, so
// two Workers built from different versions don't silently disagree.
export function registerMethod(
  module: string,
  name: string,
  method: MethodFunction,
  version: string,
) {
  registry().methods.set(method, { module, name, version });
}

// Register a `rays/durable_object` class: a public function that returns a
// `DurableObject`, and the name of the class the entry module exports for it.
export function registerClass(className: string, classFunction: ClassFunction) {
  registry().classes.set(className, classFunction);
  registry().classNames.set(classFunction, className);
}

// The function that defines the class with this name, if rays registered
// one.
export function registeredClass(className: string): ClassFunction | undefined {
  return registry().classes.get(className);
}

// The name of the class a function defines, if rays registered it.
export function registeredClassName(
  classFunction: ClassFunction,
): string | undefined {
  return registry().classNames.get(classFunction);
}

// Codec
//
// The wire format is tagged plain data that structured clone copies as is.
// Ints, floats, strings, bools and `Nil` are sent as themselves, and tuples
// are already arrays.

type Wire =
  | number
  | string
  | boolean
  | undefined
  | Wire[]
  | { $: "c"; id: string; f: Wire[] }
  | { $: "l"; items: Wire[] }
  | { $: "b"; bytes: Uint8Array; bits: number; offset: number }
  | { $: "u"; cp: number }
  | { $: "d"; entries: [Wire, Wire][] };

class CodecError extends globalThis.Error {}

function describe(value: unknown): string {
  if (value instanceof CustomType) return value.constructor.name;
  return Object.prototype.toString.call(value).slice(8, -1);
}

export function encode(value: unknown): Wire {
  switch (typeof value) {
    case "number":
    case "string":
    case "boolean":
    case "undefined":
      return value;
    case "function":
      // Workers RPC would send it as a stub that returns a promise, which
      // breaks its Gleam type.
      throw new CodecError("a function can't be sent over RPC");
  }
  if (Array.isArray(value)) return value.map(encode);
  if (List$isNonEmpty(value) || List$isEmpty(value)) {
    const items: Wire[] = [];
    let list = value as List<unknown>;
    while (List$isNonEmpty(list)) {
      items.push(encode(List$NonEmpty$first(list)));
      list = List$NonEmpty$rest(list)!;
    }
    return { $: "l", items };
  }
  if (BitArray$isBitArray(value)) {
    const bits = value as BitArray;
    // Copy only the bytes in view: structured clone would otherwise copy the
    // whole buffer the bit array is a slice of.
    return {
      $: "b",
      bytes: bits.rawBuffer.slice(),
      bits: bits.bitSize,
      offset: bits.bitOffset,
    };
  }
  if (value instanceof UtfCodepoint) {
    return { $: "u", cp: (value as unknown as { value: number }).value };
  }
  if (value instanceof Dict) {
    const entries = dicts().fold(
      value as GleamDict,
      [] as [Wire, Wire][],
      (acc: [Wire, Wire][], key: unknown, item: unknown) => {
        acc.push([encode(key), encode(item)]);
        return acc;
      },
    );
    return { $: "d", entries };
  }
  if (value instanceof CustomType) {
    const id = (value as unknown as Record<symbol, unknown>)[ID()];
    if (typeof id !== "string") {
      throw new CodecError(
        `the custom type ${describe(value)} isn't registered. Build the Worker with rays, which registers every custom type in the project.`,
      );
    }
    return { $: "c", id, f: Object.values(value).map(encode) };
  }
  throw new CodecError(`a ${describe(value)} can't be sent over RPC`);
}

export function decode(wire: Wire): unknown {
  if (typeof wire !== "object") return wire;
  if (Array.isArray(wire)) return wire.map(decode);
  switch (wire.$) {
    case "c": {
      const Ctor = registry().constructors.get(wire.id);
      if (Ctor === undefined) {
        throw new CodecError(
          `there is no custom type ${wire.id} in this Worker. Import the module that defines it, or rebuild both Workers.`,
        );
      }
      if (Ctor.length !== wire.f.length) {
        throw new CodecError(
          `${wire.id} has ${Ctor.length} fields here but ${wire.f.length} were sent. Rebuild both Workers.`,
        );
      }
      return new Ctor(...wire.f.map(decode));
    }
    case "l":
      return toList(wire.items.map(decode));
    case "b":
      return BitArray$BitArray(wire.bytes, wire.bits, wire.offset);
    case "u": {
      const codepoint = UtfCodepoint as unknown as new (cp: number) => unknown;
      return new codepoint(wire.cp);
    }
    case "d": {
      let dict = dicts().new$();
      for (const [key, item] of wire.entries) {
        dict = dicts().insert(dict, decode(key), decode(item));
      }
      return dict;
    }
  }
  throw new CodecError("the value sent isn't in the rays RPC format");
}

function toList(items: unknown[]): List<unknown> {
  let list = List$Empty<unknown>();
  for (let i = items.length - 1; i >= 0; i--)
    list = List$NonEmpty(items[i], list);
  return list;
}

// Never throws, even for a value that can't be turned into a string.
function message(error: unknown): string {
  return describeError(error, "unknown error")[1];
}

// Binding methods to a Worker

type Handler = (
  args: unknown,
  env: Env,
  ctx: ExecutionContext,
) => Promise<unknown>;

const METHODS = Symbol.for("rays.rpc.methods");

type RpcWorker = Worker & { readonly [METHODS]?: Map<MethodFunction, Handler> };

export function bind(
  worker: RpcWorker,
  method: MethodFunction,
  handler: Handler,
): RpcWorker {
  const methods = new Map(worker[METHODS]);
  methods.set(method, handler);
  return { ...worker, [METHODS]: methods };
}

// Check, when the Worker starts, that rays found every method bound to it.
// The generated entry module calls this, so a mistake stops the Worker from
// starting rather than failing calls later.
export function checkWorker(worker: RpcWorker): void {
  checkMethods(
    worker[METHODS]?.keys() ?? [],
    "worker_rpc.bind was given a function that isn't an RPC method. A method must be a public function in this package whose only argument is a worker_rpc.Params.",
  );
}

// Throw `message` if any of the methods isn't one rays registered.
export function checkMethods(
  methods: Iterable<MethodFunction>,
  message: string,
): void {
  for (const method of methods) {
    if (!registry().methods.has(method)) throw new TypeError(message);
  }
}

// Serving calls

// `m` is the module the method is defined in, as methods in different
// modules can share a name, and so the entry method.
export type Call = { m: string; v: string; args: Wire };

export type Reply =
  | { ok: Wire }
  | { error: "not_bound" | "version_mismatch" }
  | { error: "handler" | "encode" | "decode"; message: string };

// Handle a call to the method `name`. The generated entry module's
// `WorkerEntrypoint` calls this from one method per RPC method.
export function serve(
  worker: RpcWorker,
  name: string,
  call: Call,
  env: Env,
  ctx: ExecutionContext,
): Promise<Reply> {
  useEnv(env);
  return serveMethods(worker[METHODS] ?? [], name, call, (handler, args) =>
    handler(args, env, ctx),
  );
}

// Handle a call to the method `name` with one of the bound `methods`, which
// `invoke` runs. `rays/durable_object` serves its classes' methods with
// this too, with handlers that also take the instance's memory.
export async function serveMethods<H>(
  methods: Iterable<[MethodFunction, H]>,
  name: string,
  call: Call,
  invoke: (handler: H, args: unknown) => Promise<unknown>,
): Promise<Reply> {
  if (
    typeof call !== "object" ||
    call === null ||
    typeof call.m !== "string" ||
    typeof call.v !== "string" ||
    !("args" in call)
  ) {
    return {
      error: "decode",
      message: "the call isn't in the rays RPC format",
    };
  }

  let found: [H, MethodInfo] | undefined;
  for (const [method, handler] of methods) {
    const info = registry().methods.get(method);
    if (info?.name === name && info.module === call.m) found = [handler, info];
  }
  if (found === undefined) return { error: "not_bound" };
  const [handler, info] = found;
  if (call.v !== info.version) return { error: "version_mismatch" };

  let args: unknown;
  try {
    args = decode(call.args);
  } catch (error) {
    return { error: "decode", message: message(error) };
  }

  let reply: unknown;
  try {
    reply = await invoke(handler, args);
  } catch (error) {
    return { error: "handler", message: message(error) };
  }

  try {
    return { ok: encode(reply) };
  } catch (error) {
    return { error: "encode", message: message(error) };
  }
}

// Calling

// A stand-in binding from `rays/worker/simulate`, which calls the bound
// Worker's handler directly instead of going through Workers RPC.
const SIMULATED = Symbol.for("rays.rpc.simulated");

type Simulated = { worker: RpcWorker; env: Env; ctx: ExecutionContext };

// A service found by its binding name only when it is called, in the
// Worker's env, as `rays/app` makes one.
const BINDING = Symbol.for("rays.rpc.binding");

export type Service = Record<string, unknown> & {
  [SIMULATED]?: Simulated;
  [BINDING]?: string;
};

export function boundService(binding: string): Service {
  return { [BINDING]: binding };
}

export function simulatedService(
  worker: RpcWorker,
  env: Env,
  ctx: ExecutionContext,
): Service {
  return { [SIMULATED]: { worker, env, ctx } };
}

export function service(env: Env, name: string): Result<Service, undefined> {
  const value = env[name];
  return isService(value)
    ? Result$Ok(value as Service)
    : Result$Error(undefined);
}

// Service bindings and Durable Object stubs are proxies; some are callable.
function isService(value: unknown): value is Service {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null
  );
}

// What went wrong, as `#(kind, method, message)`, for `rays/worker_rpc` to
// turn into a `CallError`. `rays/durable_object` adds kinds of its own, for
// failures only a Durable Object has.
export type FailureKind =
  | "not_a_method"
  | "not_bound"
  | "version_mismatch"
  | "handler"
  | "encode"
  | "decode"
  | "not_configured"
  | "send";

export type Failure<Kind extends string = FailureKind> = [Kind, string, string];

export function call(
  service: Service,
  method: MethodFunction,
  args: unknown,
): Promise<Result<unknown, Failure>> {
  return callWith(service, method, args, () => "send");
}

// `call`, with `sendFailure` saying what kind of failure an exception the
// runtime threw while sending the call is. `rays/durable_object` uses it to
// tell its own failures apart.
export async function callWith<Kind extends string>(
  service: Service,
  method: MethodFunction,
  args: unknown,
  sendFailure: (error: unknown) => Kind | "send",
): Promise<Result<unknown, Failure<Kind | FailureKind>>> {
  // Own properties only: an RPC stub is a proxy that has every property.
  if (Object.prototype.hasOwnProperty.call(service, BINDING)) {
    const binding = service[BINDING]!;
    const found = currentEnv()?.[binding];
    if (!isService(found)) {
      const name = registry().methods.get(method)?.name ?? method.name;
      return Result$Error(["not_configured", name, binding]);
    }
    service = found;
  }
  if (Object.prototype.hasOwnProperty.call(service, SIMULATED)) {
    return callSimulated(service[SIMULATED]!, method, args);
  }

  const registered = registry().methods.get(method);
  if (registered === undefined) return Result$Error(["not_a_method", "", ""]);
  const { module, name, version } = registered;
  const fail = (kind: Kind | FailureKind, detail = "") =>
    Result$Error<unknown, Failure<Kind | FailureKind>>([kind, name, detail]);

  let wire: Wire;
  try {
    wire = encode(args);
  } catch (error) {
    return fail("encode", message(error));
  }

  // Called as a method of the binding, rather than through `Function.call`:
  // on an RPC stub, `.call` would be a remote method too.
  const stub = service as unknown as Record<
    string,
    (call: Call) => Promise<Reply>
  >;
  let reply: unknown;
  try {
    reply = await stub[name]!({ m: module, v: version, args: wire });
  } catch (error) {
    return fail(sendFailure(error), message(error));
  }

  const checked = checkReply(reply);
  if (checked === undefined) {
    return fail("decode", "the reply isn't in the rays RPC format");
  }
  if ("error" in checked) {
    return fail(checked.error, "message" in checked ? checked.message : "");
  }
  try {
    return Result$Ok(decode(checked.ok));
  } catch (error) {
    return fail("decode", message(error));
  }
}

// The reply as one `serve` sends, or `undefined` if it isn't one: the other
// end of a binding might not be a rays Worker at all.
function checkReply(reply: unknown): Reply | undefined {
  if (typeof reply !== "object" || reply === null) return undefined;
  const fields = reply as Record<string, unknown>;
  if (Object.hasOwn(fields, "ok")) return { ok: fields.ok as Wire };
  switch (fields.error) {
    case "not_bound":
    case "version_mismatch":
      return { error: fields.error };
    case "handler":
    case "encode":
    case "decode":
      return typeof fields.message === "string"
        ? { error: fields.error, message: fields.message }
        : undefined;
  }
  return undefined;
}

async function callSimulated(
  { worker, env, ctx }: Simulated,
  method: MethodFunction,
  args: unknown,
): Promise<Result<unknown, Failure>> {
  const name = registry().methods.get(method)?.name ?? method.name;
  const handler = worker[METHODS]?.get(method);
  if (handler === undefined) return Result$Error(["not_bound", name, ""]);
  try {
    return Result$Ok(await handler(args, env, ctx));
  } catch (error) {
    return Result$Error(["handler", name, message(error)]);
  }
}
