// Tests the build step behind `rays/durable_object` against a real Gleam
// compiler: finding classes and their methods, and entry modules that
// export the classes. Instances are made the way the Workers runtime makes
// them, with a stand-in `DurableObjectState`, and calls go through
// `structuredClone`, as with Workers RPC. The runtime's own behaviour, such
// as input gates and eviction, is tested in packages/integration-tests.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { build, compile, readDurableObjectClasses } from "../src/build.ts";
import { useFixture } from "./fixture.ts";

const fixture = useFixture();

const counter = `import gleam/javascript/promise.{type Promise}
import rays/durable_object.{type DurableObject, type Params}

pub fn counter() -> DurableObject(Int) {
  durable_object.new(0)
  |> durable_object.bind(add)
  |> durable_object.bind(add_slowly)
  |> durable_object.bind(read)
  |> durable_object.bind(crash)
}

pub fn add(params: Params(Int, Int)) -> Promise(Int) {
  durable_object.update_memory(params.memory, fn(count) { count + params.args })
  |> promise.resolve
}

// Waits before it updates, so two calls interleave.
pub fn add_slowly(params: Params(Int, Int)) -> Promise(Int) {
  use _ <- promise.map(promise.wait(10))
  durable_object.update_memory(params.memory, fn(count) { count + params.args })
}

pub fn read(params: Params(Nil, Int)) -> Promise(Int) {
  promise.resolve(durable_object.read_memory(params.memory))
}

pub fn crash(params: Params(Nil, Int)) -> Promise(Int) {
  durable_object.update_memory(params.memory, fn(_) { panic as "it crashed" })
  |> promise.resolve
}

pub fn unbound(params: Params(Nil, Int)) -> Promise(Int) {
  promise.resolve(durable_object.read_memory(params.memory))
}
`;

const app = `import app/counter
import gleam/javascript/promise
import rays/durable_object
import rays/worker

pub fn main() -> worker.Worker {
  worker.new(fn(_request, _env, ctx) {
    case durable_object.exported(ctx, counter.counter) {
      Ok(_) -> worker.ok() |> worker.string_body("exported")
      Error(Nil) -> worker.ok() |> worker.string_body("not exported")
    }
    |> promise.resolve
  })
}
`;

async function writeProject(): Promise<void> {
  await fixture.write("src/app/counter.gleam", counter);
  await fixture.write("src/app.gleam", app);
}

const javascript = (...parts: string[]) =>
  path.join(fixture.root, "build", "dev", "javascript", ...parts);

let imports = 0;
async function load(file: string) {
  // A query string, so each import evaluates the module afresh.
  const url = `${pathToFileURL(file).href}?t=${Date.now()}-${imports++}`;
  return import(/* @vite-ignore */ url);
}

// The same instance the compiled Gleam code imports, without a query string.
const rpcFfi = async () =>
  import(
    /* @vite-ignore */ pathToFileURL(
      javascript("rays", "rays", "worker_rpc_ffi.mts"),
    ).href
  );
const objectFfi = async () =>
  import(
    /* @vite-ignore */ pathToFileURL(
      javascript("rays", "rays", "durable_object_ffi.mts"),
    ).href
  );

// A stand-in `DurableObjectState`. Unlike the runtime, it doesn't hold calls
// back while locked work runs, so the tests wait for that themselves. It
// records how many locks were taken.
function state() {
  let woken: Promise<unknown> = Promise.resolve();
  let locks = 0;
  return {
    id: { toString: () => "0".repeat(64), name: "test" },
    waitUntil() {},
    blockConcurrencyWhile(callback: () => Promise<unknown>) {
      locks++;
      woken = callback();
      return woken;
    },
    get woken() {
      return woken;
    },
    get locks() {
      return locks;
    },
  };
}

describe("compile", () => {
  it("finds classes and both kinds of method", async () => {
    await writeProject();
    const project = await compile({ root: fixture.root });
    expect(
      project.durableObjects?.classes.map(
        ({ module, function: name, className }) => ({
          module,
          name,
          className,
        }),
      ),
    ).toEqual([
      { module: "app/counter", name: "counter", className: "Counter" },
    ]);
    expect(
      project.durableObjects?.methods.map((method) => method.name),
    ).toEqual(["add", "add_slowly", "crash", "read", "unbound"]);
    // Workers RPC methods are kept apart, and the project has none.
    expect(project.rpc).toBeUndefined();
  });

  it("names classes in PascalCase", async () => {
    await fixture.write(
      "src/app/rooms.gleam",
      "import rays/durable_object\n\npub fn chat_room_2() -> durable_object.DurableObject(Nil) {\n  durable_object.new(Nil)\n}\n",
    );
    const project = await compile({ root: fixture.root });
    expect(
      project.durableObjects?.classes.map((object) => object.className),
    ).toEqual(["ChatRoom2"]);
  });

  it("refuses a class with a generic memory type", async () => {
    await fixture.write(
      "src/app/cache.gleam",
      "import gleam/option.{type Option, None}\nimport rays/durable_object\n\npub fn cache() -> durable_object.DurableObject(Option(a)) {\n  durable_object.new(None)\n}\n",
    );
    await expect(compile({ root: fixture.root })).rejects.toThrow(
      "cache in src/app/cache.gleam is a Durable Object class with a generic memory type, gleam/option.Option. A class's memory type must be concrete.",
    );
  });

  it("refuses two classes with the same name", async () => {
    const source = (name: string) =>
      `import rays/durable_object\n\npub fn ${name}() -> durable_object.DurableObject(Nil) {\n  durable_object.new(Nil)\n}\n`;
    await fixture.write("src/app/one.gleam", source("room"));
    await fixture.write("src/app/two.gleam", source("room"));
    await expect(compile({ root: fixture.root })).rejects.toThrow(
      "room in src/app/one.gleam and room in src/app/two.gleam are both the Durable Object class Room. Rename one of them.",
    );
  });

  it("refuses a method that doesn't return a Promise", async () => {
    await fixture.write(
      "src/app/bad.gleam",
      "import rays/durable_object\n\npub fn count(params: durable_object.Params(Nil, Int)) -> Int {\n  durable_object.read_memory(params.memory)\n}\n",
    );
    await expect(compile({ root: fixture.root })).rejects.toThrow(
      "count in src/app/bad.gleam takes a durable_object.Params, so it is an RPC method and must return a Promise.",
    );
  });
});

describe("method names", () => {
  it("can't be a property of a Durable Object stub", async () => {
    await fixture.write(
      "src/app/bad.gleam",
      "import gleam/javascript/promise\nimport rays/durable_object\n\npub fn name(params: durable_object.Params(Nil, String)) -> promise.Promise(String) {\n  promise.resolve(durable_object.read_memory(params.memory))\n}\n",
    );
    await expect(compile({ root: fixture.root })).rejects.toThrow(
      "name in src/app/bad.gleam can't be an RPC method: Cloudflare uses the name name itself. Rename it.",
    );
  });
});

describe("calls that fail in the runtime", () => {
  // Durable Object exceptions carry `overloaded` and `retryable` flags.
  async function failWith(
    flags: Record<string, boolean>,
    ffi: () => Promise<{ call: Function }> = objectFfi,
  ) {
    await writeProject();
    await compile({ root: fixture.root });
    const counterModule = await load(javascript("app", "app", "counter.mjs"));
    const { call } = await ffi();
    const stub = {
      add: async () => {
        throw Object.assign(new Error("it failed"), flags);
      },
    };
    return (await call(stub, counterModule.add, 1))[0];
  }

  it("reset the instance, which a lock that timed out also marks overloaded", async () => {
    expect(
      await failWith({ durableObjectReset: true, overloaded: true }),
    ).toEqual(["reset", "add", "it failed"]);
  });

  it("are overloaded", async () => {
    expect(await failWith({ overloaded: true, retryable: false })).toEqual([
      "overloaded",
      "add",
      "it failed",
    ]);
  });

  it("can be retried", async () => {
    expect(await failWith({ retryable: true })).toEqual([
      "retryable",
      "add",
      "it failed",
    ]);
  });

  it("otherwise failed to send", async () => {
    expect(await failWith({})).toEqual(["send", "add", "it failed"]);
  });

  it("failed to send, when made through Workers RPC's call", async () => {
    expect(
      await failWith({ durableObjectReset: true, overloaded: true }, rpcFfi),
    ).toEqual(["send", "add", "it failed"]);
  });
});

describe("readDurableObjectClasses", () => {
  it("reads the class names synchronously", async () => {
    await writeProject();
    expect(readDurableObjectClasses({ root: fixture.root })).toEqual([
      "Counter",
    ]);
  });

  it("refuses a directory without gleam.toml", () => {
    expect(() => readDurableObjectClasses({ root: "/nowhere" })).toThrow(
      "No gleam.toml in /nowhere.",
    );
  });

  it("reports a project that doesn't compile", async () => {
    await fixture.write("src/app/broken.gleam", "pub fn broken( {\n");
    expect(() => readDurableObjectClasses({ root: fixture.root })).toThrow(
      "gleam export failed.",
    );
  });
});

describe("entry modules", () => {
  async function instance() {
    await writeProject();
    const [entry] = await build({ root: fixture.root });
    const source = await readFile(entry!.path, "utf8");
    const module = await load(entry!.path);
    const ctx = state();
    const object = new module.Counter(ctx, {});
    await ctx.woken;
    // A stub the way Workers RPC calls one: arguments and replies copied.
    const stub = new Proxy(
      {},
      {
        get: (_, name) => async (call: unknown) =>
          structuredClone(await object[name as string](structuredClone(call))),
      },
    );
    const counterModule = await load(javascript("app", "app", "counter.mjs"));
    const { call } = await rpcFfi();
    return { source, module, stub, counter: counterModule, call };
  }

  it("export a class with a method for each Durable Object method", async () => {
    const { source } = await instance();
    expect(source).toContain(
      "class $rays_class_Counter extends $rays_DurableObject {",
    );
    expect(source).toContain("export { $rays_class_Counter as Counter };");
    expect(source).toContain("add_slowly(call: any) {");
    // Workers RPC methods aren't in the project, so no WorkerEntrypoint.
    expect(source).not.toContain("WorkerEntrypoint");
  });

  it("export a class named like a global the module uses", async () => {
    await writeProject();
    await fixture.write(
      "src/app/symbol.gleam",
      "import rays/durable_object\n\npub fn symbol() -> durable_object.DurableObject(Nil) {\n  durable_object.new(Nil)\n}\n",
    );
    const [entry] = await build({ root: fixture.root });
    const module = await load(entry!.path);
    expect(module.Symbol).toBeTypeOf("function");
    expect(module.Symbol).not.toBe(globalThis.Symbol);
  });

  it("keep memory between calls", async () => {
    const { stub, counter, call } = await instance();
    expect((await call(stub, counter.add, 2))[0]).toBe(2);
    expect((await call(stub, counter.add, 3))[0]).toBe(5);
    expect((await call(stub, counter.read, undefined))[0]).toBe(5);
  });

  it("don't lose updates from calls that interleave", async () => {
    const { stub, counter, call } = await instance();
    const [one, two] = await Promise.all([
      call(stub, counter.add_slowly, 1),
      call(stub, counter.add_slowly, 10),
    ]);
    expect([one[0], two[0]].sort((a, b) => a - b)).toEqual([1, 11]);
    expect((await call(stub, counter.read, undefined))[0]).toBe(11);
  });

  it("leave memory alone when an update panics", async () => {
    const { stub, counter, call } = await instance();
    await call(stub, counter.add, 4);
    const crashed = await call(stub, counter.crash, undefined);
    expect(crashed.constructor.name).toBe("Error");
    expect(crashed[0]).toEqual(["handler", "crash", "it crashed"]);
    expect((await call(stub, counter.read, undefined))[0]).toBe(4);
  });

  it("start each instance with the class's memory, then run on_wake", async () => {
    await writeProject();
    await fixture.write(
      "src/app/counter.gleam",
      counter.replace(
        "  durable_object.new(0)\n",
        "  durable_object.new(0)\n  |> durable_object.on_wake(fn(wake) {\n    durable_object.update_memory(wake.memory, fn(count) { count + 100 })\n    let locked = {\n      use <- durable_object.lock(wake.context)\n      promise.resolve(Nil)\n    }\n    durable_object.wait_until(wake.context, locked)\n  })\n",
      ),
    );
    const [entry] = await build({ root: fixture.root });
    const module = await load(entry!.path);
    const counterModule = await load(javascript("app", "app", "counter.mjs"));
    const { call } = await rpcFfi();
    const stubFor = (object: Record<string, (call: unknown) => unknown>) =>
      new Proxy(
        {},
        {
          get: (_, name) => async (sent: unknown) =>
            structuredClone(
              await object[name as string]!(structuredClone(sent)),
            ),
        },
      );
    for (const _ of [1, 2]) {
      const ctx = state();
      const stub = stubFor(new module.Counter(ctx, {}));
      // on_wake ran in the constructor, and took the lock there.
      expect(ctx.locks).toBe(1);
      expect((await call(stub, counterModule.read, undefined))[0]).toBe(100);
      expect((await call(stub, counterModule.add, 1))[0]).toBe(101);
    }
  });

  it("refuse a method the class doesn't bind", async () => {
    const { stub, counter, call } = await instance();
    const result = await call(stub, counter.unbound, undefined);
    expect(result[0]).toEqual(["not_bound", "unbound", ""]);
  });

  it("refuse a call from a different version", async () => {
    const { module } = await instance();
    const ctx = state();
    const object = new module.Counter(ctx, {});
    await ctx.woken;
    expect(
      await object.add({ m: "app/counter", v: "0000000000000000", args: 1 }),
    ).toEqual({ error: "version_mismatch" });
  });

  it("register the class, so the Worker can reach it through ctx.exports", async () => {
    const { module } = await instance();
    const namespace = { idFromName() {} };
    const fetch = (exports: Record<string, unknown>) =>
      module.default
        .fetch(new Request("https://example.com/"), {}, { exports })
        .then((response: Response) => response.text());
    expect(await fetch({ Counter: namespace })).toBe("exported");
    expect(await fetch({})).toBe("not exported");
  });

  it("don't start when a bound function isn't a method", async () => {
    await writeProject();
    await fixture.write(
      "src/app/counter.gleam",
      counter
        .replace(
          "  |> durable_object.bind(crash)\n",
          "  |> durable_object.bind(crash)\n  |> durable_object.bind(hidden)\n",
        )
        .concat(
          "\nfn hidden(params: Params(Nil, Int)) -> Promise(Int) {\n  promise.resolve(durable_object.read_memory(params.memory))\n}\n",
        ),
    );
    const [entry] = await build({ root: fixture.root });
    await expect(load(entry!.path)).rejects.toThrow(
      "durable_object.bind was given a function that isn't an RPC method, for the class Counter.",
    );
  });
});
