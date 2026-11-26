// Tests `rays/durable_object`'s alarms in workerd: the `Reminders` class,
// whose handler does what its alarm's key starts with, and records each
// attempt in a `runs` table. Alarms are run by the runtime when they are
// due, as in production, so the tests wait for them to be.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { durableObject, exported, reminders, runtimeStub } from "./gleam.ts";

const stub = (name: string) =>
  runtimeStub(durableObject.get_by_name(exported(reminders.reminders), name));

// Run a check inside the named instance, with its context.
function inside<T>(name: string, check: (ctx: never) => T): Promise<T> {
  return runInDurableObject(stub(name), (_, state) => check(state as never));
}

type Run = {
  key: string;
  attempt: number;
  idempotency_key: string;
  overlapped: number;
};

const runs = (name: string) =>
  runInDurableObject(stub(name), (_, state) =>
    state.storage.sql
      .exec<Run>(
        "select key, attempt, idempotency_key, overlapped from runs order by rowid",
      )
      .toArray(),
  );

// The rows rays stores its alarms in.
const stored = (name: string) =>
  runInDurableObject(stub(name), (_, state) =>
    state.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "select key, generation, attempt, status, reason from rays_alarms order by key",
      )
      .toArray(),
  );

const schedule = (name: string, key: string, at: number) =>
  inside(name, (ctx) => reminders.schedule(ctx, key, at));

const waitFor = <T>(check: () => Promise<T>, timeout = 4_000) =>
  vi.waitFor(check, { timeout, interval: 25 });

// Whether each run of an alarm with a key starting with `prefix` finished.
const finished = (name: string, prefix: string) =>
  runInDurableObject(stub(name), (_, state) =>
    state.storage.sql
      .exec<{ finished: number }>(
        "select finished from runs where key like ? || '%' order by rowid",
        prefix,
      )
      .toArray()
      .map((run) => run.finished),
  );

const HOUR = 60 * 60 * 1000;

describe("alarms", () => {
  it("run once each when due, with their keys, and are then deleted", async () => {
    expect(await schedule("due", "first", 0)).toBe("Ok(Nil)");
    expect(await schedule("due", "second", Date.now())).toBe("Ok(Nil)");
    await waitFor(async () =>
      expect((await runs("due")).map((run) => [run.key, run.attempt])).toEqual([
        ["first", 1],
        ["second", 1],
      ]),
    );
    await waitFor(async () => expect(await stored("due")).toEqual([]));
    expect(await inside("due", (ctx) => reminders.next(ctx, "first"))).toBe(-1);
  });

  it("wait until they are due, and can be cancelled", async () => {
    const at = Date.now() + HOUR;
    await schedule("later", "visit", at);
    expect(await inside("later", (ctx) => reminders.next(ctx, "visit"))).toBe(
      at,
    );
    expect(await inside("later", (ctx) => reminders.cancel(ctx, "visit"))).toBe(
      "Ok(True)",
    );
    expect(await inside("later", (ctx) => reminders.cancel(ctx, "visit"))).toBe(
      "Ok(False)",
    );
    expect(await inside("later", (ctx) => reminders.next(ctx, "visit"))).toBe(
      -1,
    );
    expect(await runs("later")).toEqual([]);
  });

  it("set the instance's alarm to the earliest one", async () => {
    await schedule("earliest", "b", Date.now() + 2 * HOUR);
    await schedule("earliest", "a", Date.now() + HOUR);
    const a = await inside("earliest", (ctx) => reminders.next(ctx, "a"));
    expect(
      await runInDurableObject(stub("earliest"), (_, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(a);
    await inside("earliest", (ctx) => reminders.cancel(ctx, "a"));
    const b = await inside("earliest", (ctx) => reminders.next(ctx, "b"));
    expect(
      await runInDurableObject(stub("earliest"), (_, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(b);
  });

  it("run after the instance is evicted", async () => {
    await schedule("evicted", "wake", Date.now() + 100);
    await evictDurableObject(stub("evicted"));
    await waitFor(async () =>
      expect((await runs("evicted")).map((run) => run.key)).toEqual(["wake"]),
    );
  });

  it("can be scheduled inside a SQL transaction", async () => {
    expect(
      await inside("transaction", (ctx) =>
        reminders.schedule_in_transaction(ctx, "inside", 0),
      ),
    ).toBe("Ok(Nil)");
    await waitFor(async () =>
      expect((await runs("transaction")).map((run) => run.key)).toEqual([
        "inside",
      ]),
    );
  });

  it("are stored under the id their handler is registered with", async () => {
    await schedule("ids", "visit", Date.now() + HOUR);
    await inside("ids", (ctx) =>
      reminders.schedule_linger(ctx, "stay", Date.now() + HOUR),
    );
    expect(
      await runInDurableObject(stub("ids"), (_, state) =>
        state.storage.sql
          .exec("select handler, key from rays_alarms order by handler")
          .toArray(),
      ),
    ).toEqual([
      { handler: "linger", key: "stay" },
      { handler: "remind", key: "visit" },
    ]);
  });

  it("can't be scheduled for a handler the class doesn't register", async () => {
    expect(
      await inside("unregistered", (ctx) =>
        reminders.schedule_unregistered(ctx),
      ),
    ).toBe('Error(AlarmNotRegistered(handler: "unregistered"))');
  });
});

describe("rescheduling", () => {
  const generation = async (name: string) =>
    (await stored(name))[0]!.generation;

  it("for another time replaces the alarm with a new occurrence", async () => {
    await schedule("moved", "visit", Date.now() + HOUR);
    const before = await generation("moved");
    await schedule("moved", "visit", Date.now() + 2 * HOUR);
    expect(await generation("moved")).not.toBe(before);
  });

  it("for the same time sets the instance's alarm again if it is missing", async () => {
    const at = Date.now() + HOUR;
    await schedule("rearmed", "visit", at);
    await runInDurableObject(stub("rearmed"), (_, state) =>
      state.storage.deleteAlarm(),
    );
    await schedule("rearmed", "visit", at);
    expect(
      await runInDurableObject(stub("rearmed"), (_, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(at);
  });

  it("for the same time keeps the occurrence, and its idempotency key", async () => {
    const at = Date.now() + HOUR;
    await schedule("same", "visit", at);
    const before = await generation("same");
    await schedule("same", "visit", at);
    expect(await generation("same")).toBe(before);
  });

  it("from the handler leaves the next occurrence once this one is done", async () => {
    const at = Date.now();
    await schedule("recurring", "again-daily", at);
    await waitFor(async () =>
      expect(
        await inside("recurring", (ctx) => reminders.next(ctx, "again-daily")),
      ).toBe(at + HOUR),
    );
    const [run] = await runs("recurring");
    const [next] = await stored("recurring");
    // The next occurrence has a new generation, and so its own idempotency
    // key.
    expect(run!.idempotency_key).toMatch(/^rays-alarm:v1:/);
    expect(run!.idempotency_key).not.toBe(`rays-alarm:v1:${next!.generation}`);
    expect(next!.status).toBe("pending");
  });
});

describe("failed attempts", () => {
  it("are retried with the same idempotency key, until the last one", async () => {
    await schedule("retried", "retry-me", 0);
    await waitFor(async () =>
      expect(await stored("retried")).toMatchObject([
        { status: "failed", attempt: 3, reason: "asked to" },
      ]),
    );
    const attempts = await runs("retried");
    expect(attempts.map((run) => run.attempt)).toEqual([1, 2, 3]);
    expect(new Set(attempts.map((run) => run.idempotency_key)).size).toBe(1);
  });

  it("aren't retried when the handler gives up", async () => {
    await schedule("given-up", "give-up-now", 0);
    await waitFor(async () =>
      expect(await stored("given-up")).toMatchObject([
        { status: "failed", attempt: 1, reason: "asked to" },
      ]),
    );
    expect((await runs("given-up")).length).toBe(1);
  });

  it("are retried when the handler panics", async () => {
    await schedule("panicked", "panic-now", 0);
    await waitFor(async () =>
      expect(await stored("panicked")).toMatchObject([
        { status: "failed", attempt: 3 },
      ]),
    );
    const [row] = await stored("panicked");
    expect(row!.reason).toContain("panicked");
    expect(row!.reason).toContain("the handler panicked");
  });

  it("are retried when they time out, but never beside the one that timed out", async () => {
    await schedule("timed-out", "slow-call", 0);
    await waitFor(async () =>
      expect(await stored("timed-out")).toMatchObject([
        { status: "failed", attempt: 3, reason: "timed out after 100ms" },
      ]),
    );
    const attempts = await runs("timed-out");
    expect(attempts.map((run) => run.attempt)).toEqual([1, 2, 3]);
    expect(attempts.map((run) => run.overlapped)).toEqual([0, 0, 0]);
  });

  it("are tried again once the alarm is scheduled again", async () => {
    await schedule("revived", "give-up-once", 0);
    await waitFor(async () =>
      expect(await stored("revived")).toMatchObject([{ status: "failed" }]),
    );
    await schedule("revived", "give-up-once", Date.now() + HOUR);
    expect(await stored("revived")).toMatchObject([
      { status: "pending", attempt: 0, reason: null },
    ]);
  });
});

describe("attempts", () => {
  it("count when the handler resets the instance before waiting on anything", async () => {
    await schedule("reset", "reset-now", 0);
    await waitFor(
      async () =>
        expect(await stored("reset")).toMatchObject([
          {
            status: "failed",
            attempt: 3,
            reason: "every one of its 3 attempts was lost before it finished",
          },
        ]),
      12_000,
    );
  }, 15_000);

  it("that time out store the writes they make later on their own", async () => {
    await schedule("late", "slow-write", 0);
    await waitFor(async () =>
      expect(await stored("late")).toMatchObject([
        { status: "failed", reason: "timed out after 100ms" },
      ]),
    );
    // Each attempt's write after its timeout is kept, though its outcome
    // was stored as a retry before it.
    await waitFor(async () =>
      expect(await finished("late", "slow-")).toEqual([1, 1, 1]),
    );
  });
});

describe("busy instances", () => {
  it("run a due alarm while a hundred others run on past their timeouts", async () => {
    expect(
      await inside("crowded", (ctx) =>
        reminders.schedule_many(ctx, "hang-", 100, 0),
      ),
    ).toBe("Ok(Nil)");
    await schedule("crowded", "after", Date.now() + 400);
    // The hung handlers take 2 seconds, so this must run before any of them
    // finishes.
    await waitFor(async () => {
      expect((await runs("crowded")).map((run) => run.key)).toContain("after");
    }, 1_500);
    expect(await finished("crowded", "hang-")).not.toContain(1);
  });

  it("run a due alarm while another handler is still within its timeout", async () => {
    await inside("waiting", (ctx) =>
      reminders.schedule_linger(ctx, "linger", 0),
    );
    await schedule("waiting", "quick", Date.now() + 100);
    await waitFor(async () =>
      expect((await runs("waiting")).map((run) => run.key)).toContain("quick"),
    );
    // `linger` takes half a second, so `quick` ran beside it.
    expect(await finished("waiting", "linger")).toEqual([0]);
  });
});
