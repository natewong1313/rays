// Tests `raysWorker()`, at runtime and against the types of `cf/config`.

import {
  bindings,
  defineConfig,
  defineWorker,
  exports,
  type InferMainModule,
} from "cf/config";
import { describe, expect, expectTypeOf, it } from "vitest";
import { raysWorker, type RaysWorkerModule } from "./cf.ts";

const base = { name: "app", compatibilityDate: "2026-09-01" } as const;

describe("raysWorker", () => {
  it("sets the entrypoint to the rays Worker", () => {
    expect(raysWorker(base)).toEqual({
      ...base,
      entrypoint: "virtual:rays/worker",
    });
  });

  it("uses the module it is given", () => {
    expect(raysWorker(base, { module: "app/admin" }).entrypoint).toBe(
      "virtual:rays/worker/app/admin",
    );
  });

  it("keeps the rest of the configuration", () => {
    const env = { GREETING: bindings.text("Hello") };
    const worker = raysWorker({ ...base, env, compatibilityFlags: ["x"] });
    expect(worker.env).toBe(env);
    expect(worker.compatibilityFlags).toEqual(["x"]);
  });

  it("sets the entrypoint of a function's result", async () => {
    const worker = raysWorker(({ mode }) => ({ ...base, name: `app-${mode}` }));
    expect(await worker({ mode: "staging", isPreview: false })).toEqual({
      ...base,
      name: "app-staging",
      entrypoint: "virtual:rays/worker",
    });
  });

  it("sets the entrypoint of an async function's result", async () => {
    const worker = raysWorker(async () => base);
    expect(
      (await worker({ mode: undefined, isPreview: false })).entrypoint,
    ).toBe("virtual:rays/worker");
  });

  it("sets the entrypoint of a promise's result", async () => {
    const worker = raysWorker(Promise.resolve(base));
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
    const worker = raysWorker(base);
    expect(defineConfig({ worker }).worker).toBe(worker);
    expect(defineWorker(worker)).toBe(worker);

    const api = raysWorker({ ...base, name: "api" }, { module: "api" });
    const web = raysWorker({
      ...base,
      name: "web",
      env: { API: bindings.worker({ worker: api }) },
    });
    expect(defineConfig({ worker: web }).worker.env.API).toMatchObject({
      worker: api,
    });
  });

  it("types the result like the configuration it was given", () => {
    expectTypeOf(raysWorker(base)).toExtend<{
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
  const sqlite = exports.durableObject({ storage: "sqlite" });

  it("keeps the configuration's exports as they are", () => {
    const own = { Room: sqlite, Api: exports.worker() };
    expect(raysWorker({ ...base, exports: own }).exports).toBe(own);
  });

  it("exports the classes the configuration declares", () => {
    expect(
      raysWorker({ ...base, exports: { Room: sqlite, ChatRoom: sqlite } })
        .entrypoint,
    ).toBe("virtual:rays/worker?objects=ChatRoom,Room");
    expect(
      raysWorker(
        { ...base, exports: { Room: sqlite } },
        { module: "app/admin" },
      ).entrypoint,
    ).toBe("virtual:rays/worker/app/admin?objects=Room");
  });

  it("doesn't export renamed, deleted or transferred classes", () => {
    const worker = raysWorker({
      ...base,
      exports: {
        Room: sqlite,
        ChatRoom: exports.durableObject({
          state: "renamed",
          renamedTo: "Room",
        }),
        Old: exports.durableObject({ state: "deleted" }),
        Outgoing: exports.durableObject({
          state: "transferred",
          transferredTo: "other",
        }),
        Incoming: exports.durableObject({
          state: "expecting-transfer",
          storage: "sqlite",
          transferFrom: "other",
        }),
        Api: exports.worker(),
      },
    });
    expect(worker.entrypoint).toBe("virtual:rays/worker?objects=Incoming,Room");
  });

  it("exports no classes when it declares only retired ones", () => {
    const old = exports.durableObject({ state: "deleted" });
    expect(raysWorker({ ...base, exports: { Old: old } }).entrypoint).toBe(
      "virtual:rays/worker?objects=",
    );
  });

  it("leaves the classes to the plugin without Durable Object exports", () => {
    const api = { Api: exports.worker() };
    expect(raysWorker({ ...base, exports: api }).entrypoint).toBe(
      "virtual:rays/worker",
    );
  });

  it("reads the exports of a function's result each time", () => {
    let declared: Record<string, typeof sqlite> = { Room: sqlite };
    const worker = raysWorker(() => ({ ...base, exports: declared }));
    const ctx = { mode: undefined, isPreview: false };
    expect(worker(ctx).entrypoint).toBe("virtual:rays/worker?objects=Room");
    declared = { Lobby: sqlite };
    expect(worker(ctx).entrypoint).toBe("virtual:rays/worker?objects=Lobby");
  });

  it("lets bindings.durableObject() name a declared class", () => {
    const rooms = raysWorker({
      ...base,
      name: "rooms",
      exports: { ChatRoom: sqlite },
    });
    const web = raysWorker({
      ...base,
      name: "web",
      env: {
        ROOMS: bindings.durableObject({
          worker: rooms,
          exportName: "ChatRoom",
        }),
      },
    });
    expect(web.env.ROOMS).toMatchObject({ exportName: "ChatRoom" });
    // Never called: only its types are checked.
    () =>
      bindings.durableObject({
        worker: rooms,
        // @ts-expect-error: rooms doesn't declare Lobby.
        exportName: "Lobby",
      });
  });
});
