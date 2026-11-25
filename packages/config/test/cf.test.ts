// Tests `raysWorker()`, at runtime and against the types of `cf/config`.

import {
  bindings,
  defineConfig,
  defineWorker,
  type InferMainModule,
} from "cf/config";
import { describe, expect, expectTypeOf, it } from "vitest";
import { raysWorker, type RaysWorkerModule } from "../src/cf.ts";
import { useFixture } from "./fixture.ts";

const base = { name: "app", compatibilityDate: "2026-09-01" } as const;

// Declares no Durable Object classes, so the project isn't read: the tests
// don't run in one.
const none = { durableObjects: [] } as const;

describe("raysWorker", () => {
  it("sets the entrypoint to the rays Worker", () => {
    expect(raysWorker(base, none)).toEqual({
      ...base,
      entrypoint: "virtual:rays/worker",
    });
  });

  it("uses the module it is given", () => {
    expect(raysWorker(base, { ...none, module: "app/admin" }).entrypoint).toBe(
      "virtual:rays/worker/app/admin",
    );
  });

  it("keeps the rest of the configuration", () => {
    const env = { GREETING: bindings.text("Hello") };
    const worker = raysWorker(
      { ...base, env, compatibilityFlags: ["x"] },
      none,
    );
    expect(worker.env).toBe(env);
    expect(worker.compatibilityFlags).toEqual(["x"]);
  });

  it("sets the entrypoint of a function's result", async () => {
    const worker = raysWorker(
      ({ mode }) => ({ ...base, name: `app-${mode}` }),
      none,
    );
    expect(await worker({ mode: "staging", isPreview: false })).toEqual({
      ...base,
      name: "app-staging",
      entrypoint: "virtual:rays/worker",
    });
  });

  it("sets the entrypoint of an async function's result", async () => {
    const worker = raysWorker(async () => base, none);
    expect(
      (await worker({ mode: undefined, isPreview: false })).entrypoint,
    ).toBe("virtual:rays/worker");
  });

  it("sets the entrypoint of a promise's result", async () => {
    const worker = raysWorker(Promise.resolve(base), none);
    expect((await worker).entrypoint).toBe("virtual:rays/worker");
  });

  it("refuses a configuration that sets its own entrypoint", () => {
    expect(() =>
      raysWorker({ ...base, entrypoint: "./src/index.ts" } as typeof base),
    ).toThrow("raysWorker() sets the entrypoint to the rays Worker");
  });

  it("refuses a name that isn't a Gleam module", () => {
    expect(() => raysWorker(base, { module: "Admin.gleam" })).toThrow(
      'raysWorker(): "Admin.gleam" is not a Gleam module name.',
    );
  });

  it("works where defineConfig and defineWorker expect a Worker", () => {
    const worker = raysWorker(base, none);
    expect(defineConfig({ worker }).worker).toBe(worker);
    expect(defineWorker(worker)).toBe(worker);

    const api = raysWorker(
      { ...base, name: "api" },
      { ...none, module: "api" },
    );
    const web = raysWorker(
      { ...base, name: "web", env: { API: bindings.worker({ worker: api }) } },
      none,
    );
    expect(defineConfig({ worker: web }).worker.env.API).toMatchObject({
      worker: api,
    });
  });

  it("types the result like the configuration it was given", () => {
    expectTypeOf(raysWorker(base, none)).toExtend<{
      name: "app";
      compatibilityDate: "2026-09-01";
    }>();
    // Typed as the module, like a `cf-worker` import, so `cf/config` infers
    // the main module from it.
    expectTypeOf<
      InferMainModule<ReturnType<typeof raysWorker<typeof base>>>
    >().toEqualTypeOf<RaysWorkerModule>();
    expectTypeOf(raysWorker(async () => base)).toBeFunction();
    // Never called: only its types are checked.
    () =>
      // @ts-expect-error: the entrypoint is raysWorker's to set.
      raysWorker({ ...base, entrypoint: "./src/index.ts" });
  });
});

describe("raysWorker's Durable Object classes", () => {
  const fixture = useFixture();
  const sqlite = { type: "durable-object", storage: "sqlite" };
  const classes = `import rays/durable_object

pub fn chat_room() -> durable_object.DurableObject(Nil) {
  durable_object.new(Nil)
}

pub fn counter() -> durable_object.DurableObject(Int) {
  durable_object.new(0)
}
`;

  it("declares every class in the project", async () => {
    await fixture.write("src/app/objects.gleam", classes);
    expect(raysWorker(base, { root: fixture.root }).exports).toEqual({
      ChatRoom: sqlite,
      Counter: sqlite,
    });
  });

  it("declares nothing in a project without classes", () => {
    expect(raysWorker(base, { root: fixture.root })).not.toHaveProperty(
      "exports",
    );
  });

  it("keeps the configuration's own entries", async () => {
    await fixture.write("src/app/objects.gleam", classes);
    const counter = { type: "durable-object", storage: "legacy-kv" } as const;
    const worker = raysWorker(
      { ...base, exports: { Counter: counter } },
      { root: fixture.root },
    );
    expect(worker.exports).toEqual({ ChatRoom: sqlite, Counter: counter });
  });

  it("declares only the classes it is given, without reading the project", () => {
    const worker = raysWorker(base, {
      root: "/nowhere",
      durableObjects: ["ChatRoom"],
    });
    expect(worker.exports).toEqual({ ChatRoom: sqlite });
    expectTypeOf(worker.exports).toEqualTypeOf<{
      ChatRoom: { type: "durable-object"; storage: "sqlite" };
    }>();
    expect(
      raysWorker(base, { root: "/nowhere", durableObjects: [] }),
    ).not.toHaveProperty("exports");
  });

  it("declares classes in a function's result", async () => {
    await fixture.write("src/app/objects.gleam", classes);
    const worker = raysWorker(() => base, { root: fixture.root });
    expect(
      Object.keys(worker({ mode: undefined, isPreview: false }).exports ?? {}),
    ).toEqual(["ChatRoom", "Counter"]);
  });

  it("lets bindings.durableObject() name a listed class", () => {
    const rooms = raysWorker(
      { ...base, name: "rooms" },
      { durableObjects: ["ChatRoom"] },
    );
    const web = raysWorker(
      {
        ...base,
        name: "web",
        env: {
          ROOMS: bindings.durableObject({
            worker: rooms,
            exportName: "ChatRoom",
          }),
        },
      },
      { durableObjects: [] },
    );
    expect(web.env.ROOMS).toMatchObject({ exportName: "ChatRoom" });
  });

  it("refuses a directory without gleam.toml", () => {
    expect(() => raysWorker(base, { root: "/nowhere" })).toThrow(
      "No gleam.toml in /nowhere",
    );
  });

  it("reads the project each time the configuration is evaluated", async () => {
    await fixture.write("src/app/objects.gleam", classes);
    const worker = raysWorker(() => base, { root: fixture.root });
    const ctx = { mode: undefined, isPreview: false };
    expect(Object.keys(worker(ctx).exports ?? {})).toEqual([
      "ChatRoom",
      "Counter",
    ]);
    await fixture.write("src/app/objects.gleam", "pub const unused = 1\n");
    expect(worker(ctx)).not.toHaveProperty("exports");
  });

  it("reports a project that doesn't compile", async () => {
    await fixture.write("src/app/objects.gleam", "pub fn broken( {\n");
    expect(() => raysWorker(base, { root: fixture.root })).toThrow(
      "gleam export failed.",
    );
  });
});
