// Tests which entry modules hand the runtime's tracing API to `rays/trace`,
// and how they hand Durable Object classes their migrations.

import { describe, expect, it } from "vitest";
import { entrySource, type EntryOptions } from "./entry.ts";
import type { DurableObjects, WorkerRpc } from "./rpc/build.ts";

const options: EntryOptions = {
  generator: "a test",
  typescript: false,
  rpc: undefined,
  durableObjects: undefined,
  specifier: (file) => file,
};

const rpc: WorkerRpc = {
  methods: [{ kind: "worker", module: "app", name: "greet", version: "1" }],
  ffi: "/build/rays/rays/worker_rpc_ffi.mts",
};

const durableObjects: DurableObjects = {
  classes: [
    {
      module: "app/room",
      function: "room",
      className: "Room",
      compiled: "/build/app/app/room.mjs",
      migrations: undefined,
    },
  ],
  methods: [],
  ffi: "/build/rays/rays/durable_object_ffi.mts",
};

const handOff = "$rays_useTracing($rays_workers.tracing);";

const importFrom = (ffi: string) =>
  `import { useTracing as $rays_useTracing } from "${ffi}";`;

function count(source: string, text: string): number {
  return source.split(text).length - 1;
}

describe("entrySource", () => {
  it("leaves cloudflare:workers out of a Worker with only fetch", () => {
    // It gives rays/trace `ctx.tracing` on each request instead, so the
    // module still loads outside the Workers runtime.
    const source = entrySource("app", "/build/app/app.mjs", options);
    expect(source).not.toContain("cloudflare:workers");
    expect(source).not.toContain(handOff);
  });

  it("hands over tracing in a Worker with RPC methods", () => {
    const source = entrySource("app", "/build/app/app.mjs", {
      ...options,
      rpc,
    });
    expect(source).toContain(importFrom(rpc.ffi));
    expect(count(source, handOff)).toBe(1);
  });

  it("hands over tracing in a Worker with Durable Objects", () => {
    const source = entrySource("app", "/build/app/app.mjs", {
      ...options,
      durableObjects,
    });
    expect(source).toContain(importFrom(durableObjects.ffi));
    expect(count(source, handOff)).toBe(1);
  });

  it("hands over tracing once with both", () => {
    const source = entrySource("app", "/build/app/app.mjs", {
      ...options,
      rpc,
      durableObjects,
    });
    expect(count(source, handOff)).toBe(1);
    expect(count(source, "import * as $rays_workers")).toBe(1);
  });

  it("ignores type errors in the hand-off in TypeScript", () => {
    // The project's types for `cloudflare:workers` may predate `tracing`.
    const source = entrySource("app", "/build/app/app.mjs", {
      ...options,
      typescript: true,
      rpc,
    });
    expect(source).toContain(`// @ts-ignore\n${handOff}`);
  });

  it("hands a class its migrations, as written", () => {
    const migrations = [
      { name: "0001_create", sql: 'create table t (a text default "\\");\n' },
    ];
    const source = entrySource("app", "/build/app/app.mjs", {
      ...options,
      durableObjects: {
        ...durableObjects,
        classes: [{ ...durableObjects.classes[0]!, migrations }],
      },
    });
    const call = '$rays_check("Room", "room in src/app/room.gleam", ';
    const start = source.indexOf(call) + call.length;
    const end = source.indexOf(");\n", start);
    expect(JSON.parse(source.slice(start, end))).toEqual(migrations);
  });

  it("passes no migrations to a class without any", () => {
    const source = entrySource("app", "/build/app/app.mjs", {
      ...options,
      durableObjects,
    });
    expect(source).toContain(
      '$rays_check("Room", "room in src/app/room.gleam");',
    );
  });
});
