// Tests `raysTestWorkers`, which builds the rays Workers a Worker under test
// binds and describes them as auxiliary Workers for `cloudflareTest()`.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { raysTestWorkers } from "../src/vitest.ts";
import { fetcher, useFixture } from "./fixture.ts";

const fixture = useFixture();

// A second Worker in the fixture project, in app/names.
const names = `import gleam/javascript/promise
import rays/worker

pub fn main() -> worker.Worker {
  worker.new(fn(_request, _env, _ctx) {
    worker.ok()
    |> worker.string_body("Hello from names")
    |> promise.resolve
  })
}
`;

const date = "2026-09-01";
const namesWorker = {
  name: "names",
  compatibilityDate: date,
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "virtual:rays/worker/app/names",
  env: {
    GREETING: { type: "text", value: "Hi" },
    LIMITS: { type: "json", value: { max: 2 } },
    MAIN: { type: "worker", worker: "app" },
  },
};
const config = {
  worker: {
    name: "app",
    entrypoint: "virtual:rays/worker",
    env: {
      NAMES: { type: "worker", worker: namesWorker },
      // Not a rays Worker, so not built.
      OTHER: {
        type: "worker",
        worker: { name: "other", entrypoint: "./other.ts" },
      },
      GREETING: { type: "text", value: "Hello" },
    },
  },
};

async function load(file: string) {
  return import(
    /* @vite-ignore */ `${pathToFileURL(file).href}?t=${Date.now()}`
  );
}

describe("raysTestWorkers", () => {
  it("builds the rays Workers the main Worker binds", async () => {
    await fixture.write("src/app/names.gleam", names);
    const [worker, ...rest] = await raysTestWorkers(config, {
      root: fixture.root,
    });
    expect(rest).toEqual([]);
    expect(worker).toEqual({
      name: "names",
      modules: true,
      scriptPath: path.join(fixture.root, ".rays", "test", "names.js"),
      compatibilityDate: date,
      compatibilityFlags: ["nodejs_compat"],
      bindings: { GREETING: "Hi", LIMITS: { max: 2 } },
      serviceBindings: { MAIN: "app" },
    });

    const { default: built } = await load(worker!.scriptPath);
    const response = await fetcher(built)("/");
    expect(await response.text()).toBe("Hello from names");
  });

  it("evaluates a config that is a function, in test mode", async () => {
    await fixture.write("src/app/names.gleam", names);
    let mode: string | undefined;
    const workers = await raysTestWorkers(
      (ctx) => {
        mode = ctx.mode;
        return config;
      },
      { root: fixture.root },
    );
    expect(mode).toBe("test");
    expect(workers.map((worker) => worker.name)).toEqual(["names"]);
  });

  it("builds a list of Workers, including the package's own module", async () => {
    const workers = await raysTestWorkers(
      [{ name: "app", entrypoint: "virtual:rays/worker" }],
      { root: fixture.root },
    );
    expect(workers.map((worker) => worker.name)).toEqual(["app"]);
    const { default: built } = await load(workers[0]!.scriptPath);
    expect((await fetcher(built)("/")).status).toBe(200);
  });

  it("refuses a binding it can't set up, unless it is overridden", async () => {
    await fixture.write("src/app/names.gleam", names);
    const withKv = {
      ...namesWorker,
      env: { CACHE: { type: "kv" } },
    };
    await expect(
      raysTestWorkers([withKv], { root: fixture.root }),
    ).rejects.toThrow("has bindings it can't set up: CACHE (kv)");

    const [worker] = await raysTestWorkers([withKv], {
      root: fixture.root,
      overrides: { names: { kvNamespaces: ["CACHE"] } },
    });
    expect(worker!.kvNamespaces).toEqual(["CACHE"]);
  });

  it("returns nothing when no rays Worker is bound", async () => {
    expect(
      await raysTestWorkers(
        { worker: { name: "app", env: {} } },
        {
          root: fixture.root,
        },
      ),
    ).toEqual([]);
  });
});
