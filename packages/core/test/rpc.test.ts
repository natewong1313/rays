// Tests the build step behind `rays/worker_rpc` against a real Gleam
// compiler: the footers that register custom types and methods, method
// versions, the codec, and entry modules that serve methods. Calls go
// through `structuredClone`, which is how Workers RPC copies values.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { build, BuildError, compile } from "../src/build.ts";
import { FOOTER_MARKER, stripFooter } from "../src/build/rpc/footers.ts";
import { useFixture } from "./fixture.ts";

const fixture = useFixture();

// A module with methods whose types use everything the codec handles.
const values = `import gleam/dict.{type Dict}
import gleam/javascript/promise
import gleam/option.{type Option, None, Some}
import gleam/set.{type Set}
import gleam/string
import rays/worker_rpc

pub type Shape {
  Circle(radius: Float)
  Square(Int)
  Dot
}

pub type Box(a) {
  Box(inner: a)
}

pub type Values {
  Values(
    numbers: #(Int, Float, Bool, Nil),
    text: String,
    list: List(Int),
    bits: BitArray,
    odd_bits: BitArray,
    shapes: List(Option(Shape)),
    boxes: Dict(String, Box(Int)),
    tags: Set(String),
    outcome: Result(Int, String),
    codepoint: UtfCodepoint,
  )
}

pub fn sample() -> Values {
  let assert Ok(codepoint) = string.utf_codepoint(955)
  Values(
    numbers: #(-7, 1.5, True, Nil),
    text: "héllo",
    list: [1, 2, 3],
    bits: <<1, 2, 255>>,
    odd_bits: <<5:size(3)>>,
    shapes: [Some(Circle(2.0)), Some(Square(3)), Some(Dot), None],
    boxes: dict.from_list([#("a", Box(1)), #("b", Box(2))]),
    tags: set.from_list(["x", "y"]),
    outcome: Error("nope"),
    codepoint:,
  )
}

pub fn echo_values(params: worker_rpc.Params(Values)) -> promise.Promise(Values) {
  promise.resolve(params.args)
}

pub fn crash(_params: worker_rpc.Params(Nil)) -> promise.Promise(Nil) {
  panic as "it crashed"
}

// Takes a Params but isn't a method, because it takes something else too.
pub fn describe(params: worker_rpc.Params(Values), label: String) -> String {
  label <> params.args.text
}
`;

const app = `import app/values
import gleam/javascript/promise
import rays/worker
import rays/worker_rpc

pub fn main() -> worker.Worker {
  worker.new(fn(_request, _env, _context) {
    worker.ok()
    |> worker.string_body("Hello from app")
    |> promise.resolve
  })
  |> worker_rpc.bind(values.echo_values)
  |> worker_rpc.bind(values.crash)
}
`;

const javascript = (...parts: string[]) =>
  path.join(fixture.root, "build", "dev", "javascript", ...parts);

const compiled = (module: string) => javascript("app", `${module}.mjs`);

let imports = 0;
async function load(file: string) {
  // A query string, so each import evaluates the module afresh.
  const url = `${pathToFileURL(file).href}?t=${Date.now()}-${imports++}`;
  return import(/* @vite-ignore */ url);
}

// The modules the compiled Gleam code imports, without a query string, so
// they are the same instances: Gleam's equality compares classes.
const runtime = async () => ({
  ffi: await import(
    /* @vite-ignore */ pathToFileURL(
      javascript("rays", "rays", "worker_rpc_ffi.mts"),
    ).href
  ),
  isEqual: (
    await import(
      /* @vite-ignore */ pathToFileURL(javascript("prelude.mjs")).href
    )
  ).isEqual as (a: unknown, b: unknown) => boolean,
});

async function writeProject(): Promise<void> {
  await fixture.write("src/app/values.gleam", values);
  await fixture.write("src/app.gleam", app);
}

describe("footers", () => {
  it("register custom types and methods in every compiled module", async () => {
    await writeProject();
    const project = await compile({ root: fixture.root });

    expect(project.rpc?.methods.map((method) => method.name)).toEqual([
      "crash",
      "echo_values",
    ]);
    const footer = (await readFile(compiled("app/values"), "utf8")).split(
      FOOTER_MARKER,
    )[1];
    expect(footer).toContain(
      '$rays_register("app/values", { Circle, Square, Dot, Box, Values });',
    );
    expect(footer).toMatch(
      /\$rays_register_method\("app\/values", "echo_values", echo_values, "[0-9a-f]{16}"\);/,
    );

    // Dependencies' types too, including opaque ones like Set.
    const set = await readFile(
      javascript("gleam_stdlib", "gleam", "set.mjs"),
      "utf8",
    );
    expect(set).toContain('$rays_register("gleam/set", { Set });');
  });

  it("are left alone when nothing changes", async () => {
    await writeProject();
    await compile({ root: fixture.root });
    const before = await readFile(compiled("app/values"), "utf8");
    await compile({ root: fixture.root });
    expect(await readFile(compiled("app/values"), "utf8")).toBe(before);
    expect(before.split(FOOTER_MARKER).length).toBe(2);
  });

  it("are removed when the project has no methods", async () => {
    await writeProject();
    await compile({ root: fixture.root });
    await fixture.write("src/app/values.gleam", "pub type Shape {\n  Dot\n}\n");
    await fixture.write(
      "src/app.gleam",
      "import gleam/javascript/promise\nimport rays/worker\n\npub fn main() -> worker.Worker {\n  worker.new(fn(_, _, _) { promise.resolve(worker.ok()) })\n}\n",
    );
    const project = await compile({ root: fixture.root });

    expect(project.rpc).toBeUndefined();
    const set = await readFile(
      javascript("gleam_stdlib", "gleam", "set.mjs"),
      "utf8",
    );
    expect(set).not.toContain(FOOTER_MARKER);
  });
});

describe("method versions", () => {
  async function versions(): Promise<Record<string, string>> {
    const project = await compile({ root: fixture.root });
    return Object.fromEntries(
      project.rpc!.methods.map((method) => [method.name, method.version]),
    );
  }

  it("don't change when a handler does", async () => {
    await writeProject();
    const before = await versions();
    await fixture.write(
      "src/app/values.gleam",
      values.replace(
        "promise.resolve(params.args)",
        "promise.resolve(sample())",
      ),
    );
    expect(await versions()).toEqual(before);
  });

  it("change when a type the method sends does", async () => {
    await writeProject();
    const before = await versions();
    await fixture.write(
      "src/app/values.gleam",
      values
        .replace("Square(Int)", "Square(Int, Int)")
        .replace("Square(3)", "Square(3, 3)"),
    );
    const after = await versions();
    expect(after["echo_values"]).not.toBe(before["echo_values"]);
    expect(after["crash"]).toBe(before["crash"]);
  });
});

describe("method versions with opaque types", () => {
  // An opaque type, whose fields are only in the source, holding a type from
  // another module. The handler doesn't depend on that type's fields, so
  // changing them leaves the opaque type's compiled module as it was.
  const inner = (field: string, value: string) => `pub type Inner {
  Inner(value: ${field})
}

pub fn make() -> Inner {
  Inner(value: ${value})
}
`;
  const wrapper = (count: string) => `import app/inner.{type Inner}
import gleam/javascript/promise
import rays/worker_rpc

pub opaque type Wrapper {
  Wrapper(inner: Inner, count: Int)
}

pub fn get(_params: worker_rpc.Params(Nil)) -> promise.Promise(Wrapper) {
  promise.resolve(Wrapper(inner.make(), ${count}))
}
`;
  async function version(): Promise<string> {
    const project = await compile({ root: fixture.root });
    return project.rpc!.methods.find((method) => method.name === "get")!
      .version;
  }

  it("change when a type inside one, in another module, does", async () => {
    await fixture.write("src/app/inner.gleam", inner("Int", "1"));
    await fixture.write("src/app/wrapper.gleam", wrapper("1"));
    const before = await version();
    // Apart from its footer, which has the new version, the opaque type's
    // module compiles the same, so hashing it alone would miss the change.
    const withoutFooter = async () =>
      stripFooter(await readFile(compiled("app/wrapper"), "utf8"));
    const compiledWrapper = await withoutFooter();
    await fixture.write("src/app/inner.gleam", inner("String", '"1"'));
    expect(await version()).not.toBe(before);
    expect(await withoutFooter()).toBe(compiledWrapper);
  });

  it("don't change when a handler in the same module does", async () => {
    await fixture.write("src/app/inner.gleam", inner("Int", "1"));
    await fixture.write("src/app/wrapper.gleam", wrapper("1"));
    const before = await version();
    await fixture.write("src/app/wrapper.gleam", wrapper("2"));
    expect(await version()).toBe(before);
  });

  it("change when a path dependency's JavaScript FFI does", async () => {
    // rays is a path dependency of the fixture, and CallError is its type.
    await fixture.write(
      "src/app/reply.gleam",
      "import gleam/javascript/promise\nimport rays/worker_rpc\n\npub fn get(_: worker_rpc.Params(Nil)) -> promise.Promise(worker_rpc.CallError) {\n  promise.resolve(worker_rpc.NotAMethod)\n}\n",
    );
    const before = await version();
    await writeFile(
      javascript("rays", "rays", "extra_ffi.js"),
      "export const x = 1;\n",
    );
    expect(await version()).not.toBe(before);
  });
});

describe("methods that can't be used", () => {
  const method = (signature: string) =>
    `import gleam/javascript/promise\nimport rays/worker_rpc\n\n${signature} {\n  panic\n}\n`;

  it.each([
    [
      "generic",
      "pub fn pick(_: worker_rpc.Params(a)) -> promise.Promise(Int)",
      "is generic",
    ],
    [
      "sending a function",
      "pub fn pick(_: worker_rpc.Params(Int)) -> promise.Promise(fn() -> Int)",
      "sends a function",
    ],
    [
      "not returning a promise",
      "pub fn pick(_: worker_rpc.Params(Int)) -> Int",
      "must return a Promise",
    ],
    [
      "named after a handler",
      "pub fn fetch(_: worker_rpc.Params(Int)) -> promise.Promise(Int)",
      "Cloudflare uses the name fetch",
    ],
    [
      "named after the entrypoint's env",
      "pub fn env(_: worker_rpc.Params(Int)) -> promise.Promise(Int)",
      "Cloudflare uses the name env",
    ],
    [
      "named after the entrypoint's ctx",
      "pub fn ctx(_: worker_rpc.Params(Int)) -> promise.Promise(Int)",
      "Cloudflare uses the name ctx",
    ],
  ])("fail the build: %s", async (_, signature, message) => {
    await fixture.write("src/app/bad.gleam", method(signature));
    const failure = compile({ root: fixture.root });
    await expect(failure).rejects.toBeInstanceOf(BuildError);
    await expect(failure).rejects.toThrow(message);
  });
});

describe("the codec", () => {
  it("round-trips every kind of value", async () => {
    await writeProject();
    await compile({ root: fixture.root });
    const { sample } = await load(compiled("app/values"));
    const { ffi, isEqual } = await runtime();

    const value = sample();
    const copied = ffi.decode(structuredClone(ffi.encode(value)));
    expect(isEqual(copied, value)).toBe(true);
  });

  it("rejects functions", async () => {
    await writeProject();
    await compile({ root: fixture.root });
    const { ffi } = await runtime();
    expect(() => ffi.encode([1, () => 2])).toThrow("a function can't be sent");
  });

  it("rejects custom types it doesn't know", async () => {
    await writeProject();
    await compile({ root: fixture.root });
    const { ffi } = await runtime();
    expect(() => ffi.decode({ $: "c", id: "app/gone.Thing", f: [] })).toThrow(
      "there is no custom type app/gone.Thing",
    );
    expect(() =>
      ffi.decode({ $: "c", id: "app/values.Circle", f: [1, 2] }),
    ).toThrow("has 1 fields here but 2 were sent");
  });
});

describe("calls", () => {
  async function callWith(binding: unknown) {
    await writeProject();
    await compile({ root: fixture.root });
    const values = await load(compiled("app/values"));
    const { ffi } = await runtime();
    const result = await ffi.call(binding, values.crash, undefined);
    expect(result.constructor.name).toBe("Error");
    return result[0];
  }

  it.each([
    ["an empty object", {}],
    ["an unrelated object", { unrelated: 17 }],
    [
      "an error with a message that isn't a string",
      { error: "handler", message: 5 },
    ],
    ["an unknown error", { error: "nope" }],
    ["a string", "seventeen"],
  ])("fail to decode a reply that is %s", async (_, reply) => {
    expect(await callWith({ crash: async () => reply })).toEqual([
      "decode",
      "crash",
      "the reply isn't in the rays RPC format",
    ]);
  });

  it("report a rejection that can't be turned into a string", async () => {
    const binding = {
      crash: async () => {
        throw Object.create(null);
      },
    };
    expect(await callWith(binding)).toEqual(["send", "crash", "unknown error"]);
  });
});

describe("entry modules", () => {
  // A Worker built by `rays build`, and a service binding to it that copies
  // calls and replies the way Workers RPC does.
  async function serve(tamper: (call: { v: string }) => void = () => {}) {
    await writeProject();
    const [entry] = await build({ root: fixture.root });
    const source = await readFile(entry!.path, "utf8");
    const { default: Entrypoint } = await load(entry!.path);
    const instance = new Entrypoint({ waitUntil() {} }, {});
    const binding = new Proxy(
      {},
      {
        get: (_, name) => async (call: { v: string }) => {
          const copy = structuredClone(call);
          tamper(copy);
          return structuredClone(await instance[name as string](copy));
        },
      },
    );
    const values = await load(compiled("app/values"));
    const { ffi, isEqual } = await runtime();
    return { source, instance, binding, values, ffi, isEqual };
  }

  const okValue = (result: { constructor: { name: string }; 0: unknown }) => {
    expect(result.constructor.name).toBe("Ok");
    return result[0];
  };
  const errorValue = (result: {
    constructor: { name: string };
    0: unknown;
  }) => {
    expect(result.constructor.name).toBe("Error");
    return result[0];
  };

  it("serve each method from a WorkerEntrypoint", async () => {
    const { source, instance } = await serve();
    expect(source).toContain(
      'import { WorkerEntrypoint } from "cloudflare:workers";',
    );
    expect(source).toContain("echo_values(call: any) {");
    const response = await instance.fetch(new Request("https://example.com/"));
    expect(await response.text()).toBe("Hello from app");
  });

  it("answer calls with the values sent", async () => {
    const { binding, values, ffi, isEqual } = await serve();
    const result = await ffi.call(binding, values.echo_values, values.sample());
    expect(isEqual(okValue(result), values.sample())).toBe(true);
  });

  it("report a handler that panics", async () => {
    const { binding, values, ffi } = await serve();
    const result = await ffi.call(binding, values.crash, undefined);
    expect(errorValue(result)).toEqual(["handler", "crash", "it crashed"]);
  });

  it("refuse a call from a different version", async () => {
    const { binding, values, ffi } = await serve((call) => {
      call.v = "0000000000000000";
    });
    const result = await ffi.call(binding, values.echo_values, values.sample());
    expect(errorValue(result)).toEqual(["version_mismatch", "echo_values", ""]);
  });

  it("refuse a method the Worker doesn't bind", async () => {
    await writeProject();
    await fixture.write(
      "src/app.gleam",
      app.replace("  |> worker_rpc.bind(values.crash)\n", ""),
    );
    const [entry] = await build({ root: fixture.root });
    const { default: Entrypoint } = await load(entry!.path);
    const instance = new Entrypoint({}, {});
    expect(
      await instance.crash({ m: "app/values", v: "x", args: undefined }),
    ).toEqual({
      error: "not_bound",
    });
  });

  it("keep methods with the same name in different modules apart", async () => {
    await writeProject();
    const other = values
      .replace("pub fn crash(", "pub fn crash_unused(")
      .replace("pub fn describe(", "pub fn describe_unused(");
    await fixture.write("src/app/other.gleam", other);
    // Binds app/other's echo_values only.
    await fixture.write(
      "src/app.gleam",
      app
        .replace("import app/values\n", "import app/other\nimport app/values\n")
        .replace(
          "worker_rpc.bind(values.echo_values)",
          "worker_rpc.bind(other.echo_values)",
        ),
    );
    const [entry] = await build({ root: fixture.root });
    const source = await readFile(entry!.path, "utf8");
    expect(source.match(/^  echo_values\(/gm)).toHaveLength(1);

    const { default: Entrypoint } = await load(entry!.path);
    const instance = new Entrypoint({ waitUntil() {} }, {});
    const binding = new Proxy(
      {},
      {
        get: (_, name) => async (call: unknown) =>
          structuredClone(
            await instance[name as string](structuredClone(call)),
          ),
      },
    );
    const valuesModule = await load(compiled("app/values"));
    const otherModule = await load(compiled("app/other"));
    const { ffi, isEqual } = await runtime();
    const unbound = await ffi.call(
      binding,
      valuesModule.echo_values,
      valuesModule.sample(),
    );
    expect(unbound[0]).toEqual(["not_bound", "echo_values", ""]);
    const bound = await ffi.call(
      binding,
      otherModule.echo_values,
      otherModule.sample(),
    );
    expect(isEqual(bound[0], otherModule.sample())).toBe(true);
  });

  it("serve a method written in JavaScript", async () => {
    await writeProject();
    await fixture.write(
      "src/app/external.gleam",
      'import gleam/javascript/promise\nimport rays/worker_rpc\n\n@external(javascript, "./external_ffi.mjs", "double")\npub fn double(params: worker_rpc.Params(Int)) -> promise.Promise(Int)\n',
    );
    await fixture.write(
      "src/app/external_ffi.mjs",
      "export const double = async (params) => params.args * 2;\n",
    );
    await fixture.write(
      "src/app.gleam",
      app
        .replace(
          "import app/values\n",
          "import app/external\nimport app/values\n",
        )
        .replace(
          "  |> worker_rpc.bind(values.crash)\n",
          "  |> worker_rpc.bind(external.double)\n",
        ),
    );
    const [entry] = await build({ root: fixture.root });
    const { default: Entrypoint } = await load(entry!.path);
    const instance = new Entrypoint({ waitUntil() {} }, {});
    const binding = new Proxy(
      {},
      {
        get: (_, name) => async (call: unknown) =>
          structuredClone(
            await instance[name as string](structuredClone(call)),
          ),
      },
    );
    const external = await load(compiled("app/external"));
    const { ffi } = await runtime();
    const result = await ffi.call(binding, external.double, 21);
    expect(result.constructor.name).toBe("Ok");
    expect(result[0]).toBe(42);
  });

  it("don't start when the only bound function isn't a method", async () => {
    await fixture.write(
      "src/app.gleam",
      "import gleam/javascript/promise\nimport rays/worker\nimport rays/worker_rpc\n\npub fn main() -> worker.Worker {\n  worker.new(fn(_, _, _) { promise.resolve(worker.ok()) })\n  |> worker_rpc.bind(hidden)\n}\n\nfn hidden(_: worker_rpc.Params(Nil)) -> promise.Promise(Nil) {\n  promise.resolve(Nil)\n}\n",
    );
    const [entry] = await build({ root: fixture.root });
    await expect(load(entry!.path)).rejects.toThrow("isn't an RPC method");
  });

  it("don't start when a bound function isn't a method", async () => {
    await writeProject();
    await fixture.write(
      "src/app.gleam",
      app
        .replace(
          "  |> worker_rpc.bind(values.crash)\n",
          "  |> worker_rpc.bind(hidden)\n",
        )
        .concat(
          "\nfn hidden(_: worker_rpc.Params(Nil)) -> promise.Promise(Nil) {\n  promise.resolve(Nil)\n}\n",
        ),
    );
    const [entry] = await build({ root: fixture.root });
    await expect(load(entry!.path)).rejects.toThrow("isn't an RPC method");
  });
});
