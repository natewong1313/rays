// Tests `raysWorker()`, at runtime and against the types of `cf/config`.

import {
  bindings,
  defineConfig,
  defineWorker,
  type InferMainModule,
} from "cf/config";
import { describe, expect, expectTypeOf, it } from "vitest";
import { raysWorker, type RaysWorkerModule } from "../src/cf.ts";

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
    const worker = raysWorker(({ mode }) => ({
      ...base,
      name: `app-${mode}`,
    }));
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
