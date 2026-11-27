// Tests `rays/durable_object/sql` in workerd: the `Notes` class, which
// migrates its database when it wakes, and the module's functions, run
// inside an instance of it.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  durableObject,
  exported,
  inspect,
  notes,
  runtimeStub,
  sqlCheck,
} from "./gleam.ts";

const stub = (name: string) =>
  durableObject.get_by_name(exported(notes.notes), name);

async function call(name: string, method: unknown, args: unknown) {
  return inspect(
    await durableObject.call(stub(name), method as never, args as never),
  );
}

// Run a check inside the named instance, with its context.
function inside<T>(name: string, check: (ctx: never) => T): Promise<T> {
  return runInDurableObject(runtimeStub(stub(name)), (_, state) =>
    check(state as never),
  );
}

describe("the Notes class", () => {
  it("adds notes to the tables its migrations created", async () => {
    expect(await call("first", notes.add, "acorns")).toBe("Ok(Ok(1))");
    expect(await call("first", notes.add, "hazelnuts")).toBe("Ok(Ok(2))");
    expect(await call("first", notes.recent, 5)).toBe(
      'Ok(["hazelnuts", "acorns"])',
    );
  });

  it("keeps its notes when it is evicted, and doesn't migrate again", async () => {
    await call("kept", notes.add, "acorns");
    await evictDurableObject(runtimeStub(stub("kept")));
    expect(await call("kept", notes.recent, 5)).toBe('Ok(["acorns"])');
    expect(await inside("kept", sqlCheck.history)).toBe(
      'Ok(["0001_create_notes", "0002_index_notes"])',
    );
  });
});

describe("queries", () => {
  it("binds and decodes each kind of value", async () => {
    expect(await inside("values", sqlCheck.round_trip)).toBe(
      'Ok([#(-7, 1.5, "héllo \\"there\\"", <<1, 2, 255>>, <<16>>, True, False, None, Some(3), <<188>>)])',
    );
  });

  it("runs scripts of several statements, and refuses SQL transactions", async () => {
    expect(await inside("scripts", sqlCheck.scripts)).toBe(
      "#(Ok(Nil), Ok([2]), Ok(Nil), True)",
    );
  });

  it("says why a statement failed", async () => {
    expect(await inside("errors", sqlCheck.errors)).toBe(
      "#(" +
        'Error(QueryFailed(code: Some("SQLITE_CONSTRAINT_UNIQUE"), message: "UNIQUE constraint failed: people.name")), ' +
        'Error(QueryFailed(code: Some("SQLITE_ERROR"), message: "no such table: nowhere")), ' +
        'Error(QueryFailed(code: None, message: "Wrong number of parameter bindings for SQL query.")), ' +
        'Error(RowsNotDecoded(errors: [DecodeError(expected: "Int", found: "String", path: ["0"])]))' +
        ")",
    );
  });
});

describe("transactions", () => {
  it("commit on Ok and roll back on Error, inside one another too", async () => {
    expect(await inside("transactions", sqlCheck.transactions)).toBe(
      '#(Ok(Nil), 2, Error("changed my mind"), 2, Ok(Error("inner")), 3)',
    );
  });

  it("roll back when the function panics, and let the panic carry on", async () => {
    await expect(
      inside("panics", sqlCheck.panic_in_transaction),
    ).rejects.toThrow("the transaction crashed");
    expect(await inside("panics", sqlCheck.panicked_rows)).toBe(0);
  });
});

describe("delete_all", () => {
  it("empties the database, so migrating it runs every migration again", async () => {
    await call("deleted", notes.add, "acorns");
    expect(await inside("deleted", sqlCheck.delete_and_migrate)).toBe(
      '#(Ok([]), Ok(["0001_create_notes", "0002_index_notes"]))',
    );
    expect(await call("deleted", notes.recent, 5)).toBe("Ok([])");
  });
});

describe("migrations", () => {
  it("stop at one that fails, leaving none of its changes", async () => {
    expect(await inside("broken", sqlCheck.migrate_broken)).toBe(
      'Error(MigrationFailed(name: "0101_broken", reason: QueryFailed(code: Some("SQLITE_ERROR"), message: "no such table: nowhere")))',
    );
    expect(await inside("broken", sqlCheck.steps)).toBe('Ok(["step_first"])');
    expect(await inside("broken", sqlCheck.history)).toBe(
      'Ok(["0001_create_notes", "0002_index_notes", "0100_first"])',
    );
  });

  it("run the ones that haven't run when tried again", async () => {
    await inside("retried", sqlCheck.migrate_broken);
    expect(await inside("retried", sqlCheck.migrate_fixed)).toBe(
      'Ok(["0101_broken", "0102_after"])',
    );
    expect(await inside("retried", sqlCheck.steps)).toBe(
      'Ok(["step_after", "step_first", "step_half"])',
    );
    expect(await inside("retried", sqlCheck.migrate_fixed)).toBe("Ok([])");
  });
});
