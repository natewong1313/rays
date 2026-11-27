import {
  BitArray$BitArray as gleamBitArray,
  Result$Error as err,
  Result$isOk as isOk,
  Result$Ok as ok,
} from "../../gleam.mjs";
import type { Result } from "../../gleam.mjs";

export { toUint8Array as blob } from "../worker_ffi.mts";

/**
 * Below are helpers that lets sql.int, sql.float, and sql.text
 * produce the opaque sql.Value type
 *
 * This lets us require explicit bind values without writing a wrapper
 * for every value type.
 */

type Value = number | string | Uint8Array | null;

export function identity(value: number | string): Value {
  return value;
}

export function null_(): Value {
  return null;
}

// SQL stuff

const NO_STATEMENT = "SQL code did not contain a statement.";

/**
 * Safely execute a sqlite query.
 *
 * If you pass an empty script, we treat it as a no op.
 */
export function exec(
  ctx: DurableObjectState,
  sql: string,
  values: Value[],
): Result<undefined, string> {
  try {
    ctx.storage.sql.exec(sql, ...values);
    return ok(undefined);
  } catch (error) {
    const message = getErrorMessage(error);
    if (message === NO_STATEMENT) {
      return ok(undefined);
    }
    return err(message);
  }
}

/**
 * Execute a sqlite query, get the returned rows, then for each row we convert any ArrayBuffer
 * (a sqlite blob) into a BitArray so Gleam can decode.
 *
 * Unlike exec, this doesn't allow empty queries.
 */
export function query(
  ctx: DurableObjectState,
  sql: string,
  values: Value[],
): Result<unknown[][], string> {
  try {
    const rows = Array.from(ctx.storage.sql.exec(sql, ...values).raw(), (row) =>
      row.map(fromSqlite),
    );
    return ok(rows);
  } catch (error) {
    return err(getErrorMessage(error));
  }
}

function fromSqlite(value: unknown): unknown {
  return value instanceof ArrayBuffer ? gleamBitArray(new Uint8Array(value)) : value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function delete_all(ctx: DurableObjectState): Promise<undefined> {
  await ctx.storage.deleteAll();
  return undefined;
}

const SHOULD_ROLLBACK = Symbol("rays.sql.rollback");
/**
 * Starts a transaction on a DO by using ctx.storage.transactionSync
 *
 * We roll back on an error result from the transaction work or an exception.
 */
export function transaction<A, E>(
  ctx: DurableObjectState,
  transactionWork: () => Result<A, E>,
): Result<A, E> {
  let result: Result<A, E> | undefined;
  try {
    return ctx.storage.transactionSync(() => {
      result = transactionWork();
      if (isOk(result)) {
        return result;
      }
      throw SHOULD_ROLLBACK;
    });
  } catch (error) {
    if (error === SHOULD_ROLLBACK) {
      return result!;
    }
    throw error;
  }
}
