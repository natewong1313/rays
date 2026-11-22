// FFI shim for `rays/workers_rpc`: the registry the build fills in, the codec
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
import { describeError } from "./workers_ffi.mts";
import type { Env, Worker } from "./workers_ffi.mts";

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
type MethodFunction = (params: unknown) => Promise<unknown>;

interface MethodInfo {
  readonly module: string;
  readonly name: string;
  readonly version: string;
}

interface Registry {
  readonly constructors: Map<string, Constructor>;
  readonly methods: Map<MethodFunction, MethodInfo>;
}

function registry(): Registry {
  const key = Symbol.for("rays.rpc.registry");
  const store = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (store[key] ??= { constructors: new Map(), methods: new Map() });
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

// Register an RPC method: a public function taking `workers_rpc.Params`.
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
  for (const method of worker[METHODS]?.keys() ?? []) {
    if (!registry().methods.has(method)) {
      throw new TypeError(
        "workers_rpc.bind was given a function that isn't an RPC method. A method must be a public function in this package whose only argument is a workers_rpc.Params.",
      );
    }
  }
}

// Serving calls

// `m` is the module the method is defined in, as methods in different
// modules can share a name, and so the entry method.
type Call = { m: string; v: string; args: Wire };

type Reply =
  | { ok: Wire }
  | { error: "not_bound" | "version_mismatch" }
  | { error: "handler" | "encode" | "decode"; message: string };

// Handle a call to the method `name`. The generated entry module's
// `WorkerEntrypoint` calls this from one method per RPC method.
export async function serve(
  worker: RpcWorker,
  name: string,
  call: Call,
  env: Env,
  ctx: ExecutionContext,
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

  let found: [Handler, MethodInfo] | undefined;
  for (const [method, handler] of worker[METHODS] ?? []) {
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
    reply = await handler(args, env, ctx);
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

// A stand-in binding from `rays/workers/simulate`, which calls the bound
// Worker's handler directly instead of going through Workers RPC.
const SIMULATED = Symbol.for("rays.rpc.simulated");

type Simulated = { worker: RpcWorker; env: Env; ctx: ExecutionContext };

export type Service = Record<string, unknown> & { [SIMULATED]?: Simulated };

export function simulatedService(
  worker: RpcWorker,
  env: Env,
  ctx: ExecutionContext,
): Service {
  return { [SIMULATED]: { worker, env, ctx } };
}

export function service(env: Env, name: string): Result<Service, undefined> {
  const value = env[name];
  // Service bindings and Durable Object stubs are proxies; some are callable.
  return (typeof value === "object" || typeof value === "function") &&
    value !== null
    ? Result$Ok(value as Service)
    : Result$Error(undefined);
}

// What went wrong, as `#(kind, method, message)`, for `rays/workers_rpc` to
// turn into a `CallError`.
type Failure = [string, string, string];

export async function call(
  service: Service,
  method: MethodFunction,
  args: unknown,
): Promise<Result<unknown, Failure>> {
  // Own properties only: an RPC stub is a proxy that has every property.
  if (Object.prototype.hasOwnProperty.call(service, SIMULATED)) {
    return callSimulated(service[SIMULATED]!, method, args);
  }

  const registered = registry().methods.get(method);
  if (registered === undefined) return Result$Error(["not_a_method", "", ""]);
  const { module, name, version } = registered;
  const fail = (kind: string, detail = "") =>
    Result$Error<unknown, Failure>([kind, name, detail]);

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
    return fail("send", message(error));
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
