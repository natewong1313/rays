// FFI shim for `rays/durable_object/sql`: an instance's SQLite database,
// through `ctx.storage.sql`.
//
// Values are converted here, both ways: a Gleam `BitArray` is bound as
// bytes and comes back as one, and a `Bool` is bound as 1 or 0, as the
// runtime would otherwise bind it as the text "true" or "false". Ints,
// floats and strings are bound as they are. Failures come back as the
// runtime's message, which `split_code` takes SQLite's code off.

import {
  BitArray,
  Result$Error,
  Result$isOk,
  Result$Ok,
  toList,
} from "../../gleam.mjs";
import type { List, Result } from "../../gleam.mjs";

// Values

type Value = number | string | Uint8Array | null;

export function identity(value: number | string): Value {
  return value;
}

export function bool(value: boolean): Value {
  return value ? 1 : 0;
}

export function null_(): Value {
  return null;
}

// The bit array's bytes. One that isn't a whole number of bytes is padded
// with zero bits, as `bit_array.pad_to_bytes` does.
export function blob(value: BitArray): Value {
  const bytes = new Uint8Array(value.byteSize);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = value.byteAt(index);
  }
  return bytes;
}

// Statements

export function exec(
  ctx: DurableObjectState,
  sql: string,
  values: List<Value>,
): Result<undefined, string> {
  try {
    ctx.storage.sql.exec(sql, ...values.toArray());
    return Result$Ok(undefined);
  } catch (error) {
    // SQLite runs an empty script as nothing, but the runtime refuses one.
    // An empty migration, such as one an ORM starts a custom migration
    // with, runs as nothing too.
    const message = messageOf(error);
    if (message === NO_STATEMENT) return Result$Ok(undefined);
    return Result$Error(message);
  }
}

const NO_STATEMENT = "SQL code did not contain a statement.";

// The rows, each an array of its values in column order. The cursor is read
// in full here, as one held across an `await` doesn't see a stable snapshot.
export function query(
  ctx: DurableObjectState,
  sql: string,
  values: List<Value>,
): Result<List<unknown[]>, string> {
  try {
    const rows = Array.from(
      ctx.storage.sql.exec(sql, ...values.toArray()).raw(),
    );
    return Result$Ok(toList(rows.map((row) => row.map(fromSqlite))));
  } catch (error) {
    return Result$Error(messageOf(error));
  }
}

function fromSqlite(value: unknown): unknown {
  return value instanceof ArrayBuffer
    ? new BitArray(new Uint8Array(value))
    : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// "<message>: SQLITE_X", optionally followed by " (extended: SQLITE_X_Y)".
const CODE = /^([\s\S]*): (SQLITE_[A-Z0-9_]+)(?: \(extended: (SQLITE_[A-Z0-9_]+)\))?$/;

export function split_code(
  message: string,
): Result<[string, string], undefined> {
  const match = CODE.exec(message);
  if (match === null) return Result$Error(undefined);
  const [, text, primary, extended] = match;
  return Result$Ok([text!, extended ?? primary!]);
}

// Deleting everything

export async function delete_all(ctx: DurableObjectState): Promise<undefined> {
  await ctx.storage.deleteAll();
  return undefined;
}

// Transactions

// Thrown out of `transactionSync` to roll it back when the function returns
// an `Error`, which is then returned rather than thrown.
const ROLLBACK = Symbol("rays.sql.rollback");

export function transaction<A, E>(
  ctx: DurableObjectState,
  callback: () => Result<A, E>,
): Result<A, E> {
  let outcome: Result<A, E> | undefined;
  try {
    return ctx.storage.transactionSync(() => {
      outcome = callback();
      if (Result$isOk(outcome)) return outcome;
      throw ROLLBACK;
    });
  } catch (error) {
    if (error === ROLLBACK) return outcome!;
    throw error;
  }
}
