// Which waits end the batch of writes a Durable Object stores together.
// rays/durable_object's alarms rely on this: they store an attempt's outcome
// with nothing waited on after the handler settles, so it is stored in the
// same batch as the writes the handler made after its last wait.
//
// Each case saves a note, waits in some way, then resets the instance with
// `ctx.abort()`, as a crash would. If the note is gone afterwards, it hadn't
// been stored when the instance was reset, so a write made after that wait
// would have been stored in the same batch, all or nothing.

import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as gleamPromise from "../build/dev/javascript/gleam_javascript/gleam/javascript/promise.mjs";
import { durableObject, exported, notes, runtimeStub } from "./gleam.ts";

const stub = (name: string) =>
  runtimeStub(durableObject.get_by_name(exported(notes.notes), name));

// Save a note, wait, then reset the instance. Returns how many notes it
// has once it wakes again.
async function saveWaitAndReset(
  name: string,
  wait: (state: DurableObjectState) => Promise<unknown>,
): Promise<number> {
  const reset = runInDurableObject(stub(name), async (_, state) => {
    state.storage.sql.exec("insert into notes (body) values ('saved')");
    await wait(state);
    state.abort("simulated crash");
  });
  await expect(reset).rejects.toThrow();
  return runInDurableObject(
    stub(name),
    (_, state) =>
      state.storage.sql.exec("select count(*) as n from notes").one()
        .n as number,
  );
}

describe("writes made before a reset", () => {
  it("are lost when nothing is waited on in between", async () => {
    expect(await saveWaitAndReset("nothing", async () => {})).toBe(0);
  });

  it("are lost after plain promise hops", async () => {
    const hops = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    expect(await saveWaitAndReset("microtasks", hops)).toBe(0);
  });

  it("are lost after a Gleam promise.map and promise.await chain", async () => {
    // As a handler returning `promise.map(..)` would be awaited by rays.
    const chain = () => {
      const p = gleamPromise.map(gleamPromise.resolve(undefined), (x) => x);
      return gleamPromise.await$(p, (x) => gleamPromise.resolve(x));
    };
    expect(await saveWaitAndReset("gleam-chain", chain)).toBe(0);
  });

  it("are lost after awaiting a storage read", async () => {
    // A SQLite-backed instance reads its storage locally, so this isn't a
    // wait on anything outside it.
    expect(
      await saveWaitAndReset("storage-get", (state) => state.storage.get("k")),
    ).toBe(0);
  });

  it("are kept after a call to another Worker", async () => {
    const call = () =>
      exports.default.fetch("http://example.com/").catch(() => undefined);
    expect(await saveWaitAndReset("subrequest", call)).toBe(1);
  });

  it("are kept after waiting on a timer", async () => {
    const timer = () => new Promise((resolve) => setTimeout(resolve, 10));
    expect(await saveWaitAndReset("timer", timer)).toBe(1);
  });
});
