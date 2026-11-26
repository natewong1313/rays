// FFI shim for `rays/durable_object`'s alarms: many named alarms on the one
// alarm Cloudflare gives each instance.
//
// Every occurrence is a row of `rays_alarms`, in the instance's SQLite
// database, keyed by the id its handler was registered with and its key. The instance's real
// alarm is always set to the earliest time any row is due, by the same
// synchronous code that changes the rows, so the two are stored together.
// When it fires, the class's `alarm` method calls `runAlarms`, which runs
// every due row, stores each one's outcome, and sets the alarm again.
//
// A row's `generation` is a new id each time the occurrence is scheduled.
// It is what the handler's idempotency key is made from, and every write
// that stores an attempt's outcome checks it, and the attempt number, so an
// attempt that was replaced, cancelled or timed out can't change the row
// that took its place.
//
// Each row keeps its own attempt count and backoff. The runner schedules
// a recovery wake on failure and lets Cloudflare retry if that write fails.

import { Result$Error, Result$Ok } from "../../gleam.mjs";
import type { Result } from "../../gleam.mjs";
import { describeError, type Env } from "../worker_ffi.mts";

export type AlarmFunction = (alarm: unknown) => Promise<unknown>;

// What the Gleam `register_alarm` wraps a handler in: it makes the `Alarm`
// record, and turns the handler's `Outcome` into a pair.
type Outcome = ["done" | "retry" | "give_up", string];
type Run = (
  key: string,
  scheduledAt: number,
  attempt: number,
  idempotencyKey: string,
  env: Env,
  ctx: DurableObjectState,
  memory: unknown,
) => Promise<Outcome>;

export interface AlarmConfig {
  // What its alarms are stored under.
  readonly id: string;
  readonly run: Run;
  // The milliseconds to wait after the given attempt fails.
  readonly delay: (attempt: number) => number;
  readonly maxAttempts: number;
  readonly timeout: number;
  // Why the arguments `register_alarm` was given can't be used, or "".
  readonly problem: string;
}

// The part of a class definition alarms use. `durable_object_ffi.mts` keeps
// the rest.
interface WithAlarms {
  readonly alarms: ReadonlyMap<AlarmFunction, AlarmConfig>;
}

export function registerAlarm<D extends WithAlarms>(
  definition: D,
  handler: AlarmFunction,
  id: string,
  run: Run,
  delay: (attempt: number) => number,
  maxAttempts: number,
  timeout: number,
  problem: string,
): D {
  const alarms = new Map(definition.alarms);
  alarms.set(handler, { id, run, delay, maxAttempts, timeout, problem });
  return { ...definition, alarms };
}

// Check, when the Worker starts, that every handler a class registers was
// given arguments it can use, and an id of its own.
export function checkAlarms(definition: WithAlarms, className: string): void {
  const ids = new Set<string>();
  for (const config of definition.alarms.values()) {
    const where = `The alarm handler ${JSON.stringify(config.id)} of the class ${className}`;
    if (config.problem !== "") {
      throw new TypeError(`${where} can't be registered: ${config.problem}.`);
    }
    if (ids.has(config.id)) {
      throw new TypeError(
        `${where} is registered twice, for different functions. Give each handler an id of its own.`,
      );
    }
    ids.add(config.id);
  }
}

// Instances
//
// What alarms need of an instance, by its `DurableObjectState`, which is the
// Gleam `Context`: scheduling finds the id its class registered the handler
// with, and running a handler needs the instance's env and memory.

interface Running {
  readonly handler: string;
  readonly key: string;
  // How long its handler was given: while it is still running after that,
  // its row is checked again this often.
  readonly timeout: number;
}

interface Instance {
  readonly byHandler: ReadonlyMap<AlarmFunction, AlarmConfig>;
  readonly byId: ReadonlyMap<string, AlarmConfig>;
  readonly env: Env;
  readonly memory: unknown;
  // The occurrences whose handlers are running, by `occurrence`. One stays
  // here until its handler settles, even after it timed out, so an
  // occurrence never has two attempts running at once.
  readonly running: Map<string, Running>;
}

const instances = new WeakMap<DurableObjectState, Instance>();

export function rememberInstance(
  definition: WithAlarms,
  ctx: DurableObjectState,
  env: Env,
  memory: unknown,
): void {
  const byId = new Map<string, AlarmConfig>();
  for (const config of definition.alarms.values()) byId.set(config.id, config);
  instances.set(ctx, {
    byHandler: definition.alarms,
    byId,
    env,
    memory,
    running: new Map(),
  });
}

const occurrence = (handler: string, key: string) =>
  JSON.stringify([handler, key]);

// Storage

const TABLE = "rays_alarms";

// After the first wait of an attempt that is lost with its instance, the
// row is due again once the attempt's timeout and this have passed.
const LEASE_MARGIN = 1_000;

// How long a due row whose handler the class no longer registers waits
// before it is looked at again, as during a deploy that removes it.
const UNREGISTERED_RECHECK = 60_000;

// At most this many due rows are started by one run of the alarm. More are
// started by the next, straight after.
const BATCH = 100;

// After `runAlarms` itself fails, as when storage does, it runs again this
// much later.
const FAILED_RUN_RETRY = 30_000;

type Row = {
  handler: string;
  key: string;
  generation: string;
  scheduled_at: number;
  attempt: number;
};

function createTable(sql: SqlStorage): void {
  sql.exec(`create table if not exists ${TABLE} (
    handler text not null,
    key text not null,
    generation text not null,
    scheduled_at integer not null,
    next_attempt_at integer not null,
    attempt integer not null,
    status text not null,
    reason text,
    primary key (handler, key)
  ) without rowid`);
  sql.exec(
    `create index if not exists ${TABLE}_due on ${TABLE} (status, next_attempt_at)`,
  );
}

// Reads don't create the table, so an instance that never schedules an
// alarm stores nothing.
function hasTable(sql: SqlStorage): boolean {
  return (
    sql
      .exec(
        "select 1 from sqlite_master where type = 'table' and name = ?",
        TABLE,
      )
      .toArray().length > 0
  );
}

// Set the instance's alarm to when the earliest pending row is due, or
// delete it if none is. A row whose handler is still running is due no
// sooner than its timeout from now: its handler can't run again until the
// running one settles, and an earlier alarm would only find it running.
//
// It doesn't wait for the alarm to be set: the runtime stores the alarm
// with the writes made around it, before the instance replies to anything.
function arm(ctx: DurableObjectState, instance: Instance | undefined): void {
  const now = Date.now();
  let target: number | undefined;
  const pending = ctx.storage.sql.exec<{
    handler: string;
    key: string;
    next_attempt_at: number;
  }>(
    `select handler, key, next_attempt_at from ${TABLE}
     where status = 'pending' order by next_attempt_at`,
  );
  // In order of time, so the first row that isn't running is the earliest
  // that can run. Running rows before it may be due later than it.
  for (const row of pending) {
    const running = instance?.running.get(occurrence(row.handler, row.key));
    const at =
      running === undefined
        ? row.next_attempt_at
        : Math.max(row.next_attempt_at, now + running.timeout);
    target = target === undefined ? at : Math.min(target, at);
    if (running === undefined) break;
  }
  settleQuietly(
    target === undefined
      ? ctx.storage.deleteAlarm()
      : // A time that has passed runs the alarm straight away, but the
        // runtime refuses one that isn't after the Unix epoch.
        ctx.storage.setAlarm(Math.max(target, 1)),
  );
}

function settleQuietly(promise: Promise<unknown>): void {
  promise.catch((error) =>
    console.error({
      message: "rays couldn't set the alarm",
      error: messageOf(error),
    }),
  );
}

// Scheduling

type AlarmFailure = ["not_registered" | "storage", string];

// The id the instance's class registered the handler with, and the
// instance, or the failure to give back if it didn't register it.
function registeredHere(
  ctx: DurableObjectState,
  handler: AlarmFunction,
): { name: string; instance: Instance } | Result<never, AlarmFailure> {
  const instance = instances.get(ctx);
  const config = instance?.byHandler.get(handler);
  if (instance === undefined || config === undefined) {
    return Result$Error([
      "not_registered",
      handler.name || "an anonymous function",
    ]);
  }
  return { name: config.id, instance };
}

export function schedule(
  ctx: DurableObjectState,
  handler: AlarmFunction,
  key: string,
  at: number,
): Result<undefined, AlarmFailure> {
  const registered = registeredHere(ctx, handler);
  if (!("name" in registered)) return registered;
  const { name, instance } = registered;
  const time = Math.trunc(at);
  try {
    ctx.storage.transactionSync(() => {
      const sql = ctx.storage.sql;
      createTable(sql);
      const [existing] = sql
        .exec<{ status: string; scheduled_at: number }>(
          `select status, scheduled_at from ${TABLE} where handler = ? and key = ?`,
          name,
          key,
        )
        .toArray();
      // Already pending for that time: the same occurrence, so it keeps its
      // generation, and so its idempotency key, and its attempts.
      // The instance's alarm is set again all the same, in case it was lost.
      if (existing?.status === "pending" && existing.scheduled_at === time) {
        arm(ctx, instance);
        return;
      }
      sql.exec(
        `insert into ${TABLE}
           (handler, key, generation, scheduled_at, next_attempt_at, attempt, status, reason)
         values (?, ?, ?, ?, ?, 0, 'pending', null)
         on conflict (handler, key) do update set
           generation = excluded.generation,
           scheduled_at = excluded.scheduled_at,
           next_attempt_at = excluded.next_attempt_at,
           attempt = 0,
           status = 'pending',
           reason = null`,
        name,
        key,
        crypto.randomUUID(),
        time,
        time,
      );
      arm(ctx, instance);
    });
    return Result$Ok(undefined);
  } catch (error) {
    return Result$Error(["storage", messageOf(error)]);
  }
}

export function cancel(
  ctx: DurableObjectState,
  handler: AlarmFunction,
  key: string,
): Result<boolean, AlarmFailure> {
  const registered = registeredHere(ctx, handler);
  if (!("name" in registered)) return registered;
  const { name, instance } = registered;
  try {
    if (!hasTable(ctx.storage.sql)) return Result$Ok(false);
    const deleted = ctx.storage.transactionSync(() => {
      const removed =
        ctx.storage.sql
          .exec(
            `delete from ${TABLE} where handler = ? and key = ? returning key`,
            name,
            key,
          )
          .toArray().length > 0;
      if (removed) arm(ctx, instance);
      return removed;
    });
    return Result$Ok(deleted);
  } catch (error) {
    return Result$Error(["storage", messageOf(error)]);
  }
}

export function next(
  ctx: DurableObjectState,
  handler: AlarmFunction,
  key: string,
): Result<number, undefined> {
  const name = instances.get(ctx)?.byHandler.get(handler)?.id;
  if (name === undefined) return Result$Error(undefined);
  try {
    if (!hasTable(ctx.storage.sql)) return Result$Error(undefined);
    const [row] = ctx.storage.sql
      .exec<{ next_attempt_at: number }>(
        `select next_attempt_at from ${TABLE}
         where handler = ? and key = ? and status = 'pending'`,
        name,
        key,
      )
      .toArray();
    return row === undefined
      ? Result$Error(undefined)
      : Result$Ok(row.next_attempt_at);
  } catch {
    return Result$Error(undefined);
  }
}

// Running
//
// The class's `alarm` method claims every due alarm, stores the claims,
// then starts their handlers and returns, without waiting for them: a slow
// handler doesn't hold back alarms that come due while it runs, as
// Cloudflare runs one `alarm` at a time. Each handler stores its outcome
// when it settles, and sets the instance's alarm again. The handlers keep
// the instance running, with `waitUntil`, and if it is lost anyway, their
// claims bring their rows round again.
//
// An outcome is stored in the same synchronous step as the handler's
// promise settling, with nothing waited on in between, so the runtime
// stores it in the same batch as the writes the handler made after its
// last wait: an outcome is never stored without them, nor they without it.
// An attempt that times out is the exception: its outcome is stored when
// it times out, and the writes it makes later are stored on their own.

interface Claim {
  readonly row: Row;
  readonly config: AlarmConfig;
  readonly attempt: number;
}

export async function runAlarms(ctx: DurableObjectState): Promise<void> {
  const instance = instances.get(ctx);
  try {
    const sql = ctx.storage.sql;
    if (!hasTable(sql)) {
      settleQuietly(ctx.storage.deleteAlarm());
      return;
    }
    const now = Date.now();
    const claims: Claim[] = [];
    for (const row of runnable(sql, instance, now)) {
      const config = instance?.byId.get(row.handler);
      if (config === undefined) {
        postponeUnregistered(sql, row, now);
        continue;
      }
      const attempt = claim(sql, row, config, now);
      if (attempt === undefined) {
        fail(
          sql,
          row,
          row.attempt,
          `every one of its ${config.maxAttempts} attempts was lost before it finished`,
        );
        continue;
      }
      claims.push({ row, config, attempt });
    }
    // The claims, and an alarm for when they run out, are stored before any
    // handler runs. A handler that resets the instance before waiting on
    // anything would otherwise lose its claim with it, and its attempt
    // wouldn't count.
    arm(ctx, instance);
    if (claims.length === 0) return;
    await ctx.storage.sync();
    for (const claimed of claims) {
      // Cancelled or replaced while the claims were stored.
      if (!stillClaimed(sql, claimed)) continue;
      start(ctx, instance!, claimed);
    }
    arm(ctx, instance);
  } catch (error) {
    // Use Cloudflare's retries if we can't schedule our own.
    console.error({
      message: "rays couldn't run the instance's alarms",
      error: messageOf(error),
    });
    await ctx.storage.setAlarm(Date.now() + FAILED_RUN_RETRY);
  }
}

// The due rows whose handlers aren't running, at most `BATCH` of them. The
// rows `arm` sets the alarm for are the same: a due row that is running
// isn't, so the alarm never fires for rows it can't run.
function runnable(
  sql: SqlStorage,
  instance: Instance | undefined,
  now: number,
): Row[] {
  const running = JSON.stringify(
    [...(instance?.running.values() ?? [])].map(({ handler, key }) => [
      handler,
      key,
    ]),
  );
  return sql
    .exec<Row>(
      `select a.handler, a.key, a.generation, a.scheduled_at, a.attempt
       from ${TABLE} a
       where a.status = 'pending' and a.next_attempt_at <= ?
         and not exists (
           select 1 from json_each(?) r
           where json_extract(r.value, '$[0]') = a.handler
             and json_extract(r.value, '$[1]') = a.key
         )
       order by a.next_attempt_at limit ?`,
      now,
      running,
      BATCH,
    )
    .toArray();
}

// Count the attempt before its handler runs, so attempts lost with the
// instance count too, and a handler that crashes it every time stops.
// Until the attempt stores its outcome, its row is due again only once its
// timeout has passed, in case it is lost.
function claim(
  sql: SqlStorage,
  row: Row,
  config: AlarmConfig,
  now: number,
): number | undefined {
  const [claimed] = sql
    .exec<{ attempt: number }>(
      `update ${TABLE} set attempt = attempt + 1, next_attempt_at = ?
       where handler = ? and key = ? and generation = ?
         and status = 'pending' and attempt < ?
       returning attempt`,
      now + config.timeout + LEASE_MARGIN,
      row.handler,
      row.key,
      row.generation,
      config.maxAttempts,
    )
    .toArray();
  return claimed?.attempt;
}

function stillClaimed(sql: SqlStorage, { row, attempt }: Claim): boolean {
  return (
    sql
      .exec(
        `select 1 from ${TABLE}
         where handler = ? and key = ? and generation = ? and attempt = ?
           and status = 'pending'`,
        row.handler,
        row.key,
        row.generation,
        attempt,
      )
      .toArray().length > 0
  );
}

// Kept, rather than failed, as a handler is usually missing because a
// deploy is under way: the version that has it runs it.
function postponeUnregistered(sql: SqlStorage, row: Row, now: number): void {
  console.warn({
    message: "An alarm is due, but its class doesn't register its handler",
    handler: row.handler,
    key: row.key,
  });
  sql.exec(
    `update ${TABLE} set next_attempt_at = ?
     where handler = ? and key = ? and generation = ?`,
    now + UNREGISTERED_RECHECK,
    row.handler,
    row.key,
    row.generation,
  );
}

// Start the handler of a claimed attempt, and store its outcome when it
// settles or times out. Nothing waits for it but the instance, through
// `waitUntil`, so it catches its own failures.
function start(
  ctx: DurableObjectState,
  instance: Instance,
  { row, config, attempt }: Claim,
): void {
  const id = occurrence(row.handler, row.key);
  const running: Running = {
    handler: row.handler,
    key: row.key,
    timeout: config.timeout,
  };
  instance.running.set(id, running);

  let settle!: (outcome: Outcome) => void;
  const settled = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    settle(["retry", `timed out after ${config.timeout}ms`]);
  }, config.timeout);

  const handled = Promise.resolve()
    .then(() =>
      config.run(
        row.key,
        row.scheduled_at,
        attempt,
        `rays-alarm:v1:${row.generation}`,
        instance.env,
        ctx,
        instance.memory,
      ),
    )
    .then(
      (outcome): Outcome => outcome,
      (error): Outcome => ["retry", `panicked: ${messageOf(error)}`],
    );

  // The handler's own lifetime: it leaves `running` only once it settles,
  // even after it timed out, so the alarm never has two attempts at once.
  const finished = handled.then((outcome) => {
    clearTimeout(timer);
    settle(outcome);
    if (instance.running.get(id) === running) instance.running.delete(id);
    // Its row was left alone while it ran on after its timeout.
    if (timedOut) arm(ctx, instance);
  });

  const stored = settled.then(([kind, reason]) => {
    storeOutcome(ctx.storage.sql, row, config, attempt, kind, reason);
    arm(ctx, instance);
  });

  ctx.waitUntil(
    Promise.all([finished, stored]).catch((error) =>
      console.error({
        message: "rays couldn't store an alarm's outcome",
        handler: row.handler,
        key: row.key,
        attempt,
        error: messageOf(error),
      }),
    ),
  );
}

// Every write checks the row is still this attempt's, so one that was
// replaced, cancelled, or timed out can't change the row that took its
// place.
function storeOutcome(
  sql: SqlStorage,
  row: Row,
  config: AlarmConfig,
  attempt: number,
  kind: Outcome[0],
  reason: string,
): void {
  const guard = [row.handler, row.key, row.generation, attempt] as const;
  const owns = "handler = ? and key = ? and generation = ? and attempt = ?";
  switch (kind) {
    case "done":
      sql.exec(`delete from ${TABLE} where ${owns}`, ...guard);
      return;
    case "give_up":
      fail(sql, row, attempt, reason);
      return;
    case "retry": {
      if (attempt >= config.maxAttempts) {
        fail(sql, row, attempt, reason);
        return;
      }
      const retried =
        sql
          .exec(
            `update ${TABLE} set next_attempt_at = ?, reason = ?
             where ${owns} and status = 'pending' returning key`,
            Date.now() + Math.max(0, config.delay(attempt)),
            reason,
            ...guard,
          )
          .toArray().length > 0;
      if (!retried) return;
      console.warn({
        message: "An alarm failed, and will be tried again",
        handler: row.handler,
        key: row.key,
        attempt,
        reason,
      });
      return;
    }
  }
}

function fail(
  sql: SqlStorage,
  row: Row,
  attempt: number,
  reason: string,
): void {
  const failed =
    sql
      .exec(
        `update ${TABLE} set status = 'failed', reason = ?
         where handler = ? and key = ? and generation = ? and attempt = ?
           and status = 'pending'
         returning key`,
        reason,
        row.handler,
        row.key,
        row.generation,
        attempt,
      )
      .toArray().length > 0;
  if (failed) {
    console.error({
      message: "An alarm failed, and won't be tried again",
      handler: row.handler,
      key: row.key,
      attempt,
      reason,
    });
  }
}

function messageOf(error: unknown): string {
  return describeError(error, "an error that can't be shown")[1];
}
