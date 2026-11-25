// Tests `rays/durable_object` in workerd: reaching instances, their memory,
// how calls interleave and what the lock does, failures, and waking.

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  counter,
  durableObject,
  exported,
  inspect,
  sleepy,
  unwrap,
} from "./gleam.ts";

const counters = () => exported(counter.counter);

// Call a method on the named instance, and inspect the `Result`.
async function call<Args>(
  namespace: durableObject.Namespace$<unknown>,
  name: string,
  method: (params: never) => Promise<unknown>,
  args: Args,
): Promise<string> {
  const stub = durableObject.get_by_name(namespace, name);
  return inspect(await durableObject.call(stub, method as never, args));
}

const read = (name: string) => call(counters(), name, counter.read, undefined);

describe("reaching an instance", () => {
  it("is the same instance by ctx.exports, a binding, an id or a hint", async () => {
    await call(counters(), "shared", counter.add_slowly, 5);
    const bound = unwrap<durableObject.Namespace$<unknown>>(
      durableObject.namespace(env as never, "COUNTERS"),
    );
    expect(await call(bound, "shared", counter.read, undefined)).toBe("Ok(5)");

    const id = durableObject.id_from_name(counters(), "shared");
    const parsed = unwrap<durableObject.Id$>(
      durableObject.id_from_string(counters(), durableObject.id_to_string(id)),
    );
    const byId = durableObject.get(counters(), parsed);
    expect(
      inspect(await durableObject.call(byId, counter.read, undefined)),
    ).toBe("Ok(5)");

    const hinted = durableObject.location_hint(
      counters(),
      durableObject.LocationHint$WesternEurope(),
    );
    expect(await call(hinted, "shared", counter.read, undefined)).toBe("Ok(5)");
  });

  it("is a different instance for each name", async () => {
    await call(counters(), "one", counter.add_slowly, 1);
    expect(await read("two")).toBe("Ok(0)");
  });

  it("has no namespace for a binding that doesn't exist", () => {
    expect(inspect(durableObject.namespace(env as never, "MISSING"))).toBe(
      "Error(Nil)",
    );
  });

  it("refuses an id that isn't one of the namespace's", () => {
    expect(inspect(durableObject.id_from_string(counters(), "nope"))).toBe(
      "Error(Nil)",
    );
  });
});

describe("memory", () => {
  it("is forgotten when the instance is evicted", async () => {
    await call(counters(), "evicted", counter.add_slowly, 7);
    await evictDurableObject(
      durableObject.get_by_name(counters(), "evicted") as DurableObjectStub,
    );
    expect(await read("evicted")).toBe("Ok(0)");
  });
});

describe("calls that interleave", () => {
  // Five calls at once, each adding its amount after a wait.
  const addAll = (name: string, method: (params: never) => Promise<unknown>) =>
    Promise.all(
      [1, 2, 3, 4, 5].map((amount) => call(counters(), name, method, amount)),
    );

  it("don't lose updates made with update_memory", async () => {
    const added = await addAll("busy", counter.add_slowly);
    expect(added.every((reply) => reply.startsWith("Ok("))).toBe(true);
    expect(await read("busy")).toBe("Ok(15)");
  });

  it("lose updates written from a read made before an await", async () => {
    await addAll("racy", counter.add_from_read);
    // Every call read 0 before any of them wrote.
    expect(await read("racy")).not.toBe("Ok(15)");
  });

  it("don't lose them with the lock held", async () => {
    await addAll("locked", counter.add_locked);
    expect(await read("locked")).toBe("Ok(15)");
  });

  it("can take the lock inside the lock", async () => {
    await addAll("nested", counter.add_nested);
    expect(await read("nested")).toBe("Ok(15)");
  });
});

describe("failures", () => {
  it("leave the memory alone when an update panics", async () => {
    await call(counters(), "crashing", counter.add_slowly, 7);
    expect(await call(counters(), "crashing", counter.crash, undefined)).toBe(
      'Error(RpcFailed(reason: HandlerFailed(method: "crash", message: "the update crashed")))',
    );
    expect(await read("crashing")).toBe("Ok(7)");
  });

  it("reset the instance when locked work panics", async () => {
    await call(counters(), "reset", counter.add_slowly, 7);
    expect(
      await call(counters(), "reset", counter.crash_locked, undefined),
    ).toBe(
      'Error(Reset(method: "crash_locked", message: "the locked work crashed"))',
    );
    expect(await read("reset")).toBe("Ok(0)");
  });

  it("reset the instance when the locked function panics before it returns", async () => {
    await call(counters(), "reset-now", counter.add_slowly, 7);
    expect(
      await call(counters(), "reset-now", counter.crash_locking, undefined),
    ).toBe(
      'Error(Reset(method: "crash_locking", message: "the lock crashed"))',
    );
    expect(await read("reset-now")).toBe("Ok(0)");
  });

  // The stub, untyped: its methods take calls in the rays format.
  const rawStub = (name: string) =>
    durableObject.get_by_name(counters(), name) as unknown as Record<
      string,
      (call: unknown) => Promise<unknown>
    >;

  it("refuse a call from a different version", async () => {
    expect(
      await rawStub("versions").add_slowly!({
        m: "integration_tests/counter",
        v: "0000000000000000",
        args: 1,
      }),
    ).toEqual({ error: "version_mismatch" });
  });

  it("refuse a method the class doesn't bind", async () => {
    // Every class has an entry for every method, and serves its own.
    expect(
      await rawStub("unbound").woken_as!({
        m: "integration_tests/sleepy",
        v: "0000000000000000",
        args: undefined,
      }),
    ).toEqual({ error: "not_bound" });
  });
});

describe("waking", () => {
  const woken = (namespace: durableObject.Namespace$<unknown>, name: string) =>
    call(namespace, name, sleepy.woken_as, undefined);

  it("holds calls back until locked wake work is done", async () => {
    expect(await woken(exported(sleepy.sleepy), "ada")).toBe('Ok("ada")');
  });

  it("doesn't hold calls back for wake work without the lock", async () => {
    expect(await woken(exported(sleepy.restless), "ada")).toBe(
      'Ok("still waking")',
    );
  });

  it("gives an instance made from a unique id no name", async () => {
    const namespace = exported(sleepy.sleepy);
    const stub = durableObject.get(
      namespace,
      durableObject.new_unique_id(namespace),
    );
    expect(
      inspect(await durableObject.call(stub, sleepy.woken_as, undefined)),
    ).toBe('Ok("no name")');
  });

  it("fails the call when the instance can't wake, and tries again", async () => {
    // A panic in on_wake means the instance is never created.
    const failed =
      'Error(RpcFailed(reason: SendFailed(method: "woken_as", message: "this instance can\'t wake")))';
    expect(await woken(exported(sleepy.sleepy), "broken")).toBe(failed);
    // The next call wakes it again, and fails the same way.
    expect(await woken(exported(sleepy.sleepy), "broken")).toBe(failed);
  });
});
