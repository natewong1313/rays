//// The `Reminders` class, for the tests of `rays/durable_object`'s alarms.
//// Its one handler, `remind`, does what its alarm's key starts with, and
//// records each attempt in a `runs` table for the tests to read.

import gleam/dynamic/decode
import gleam/int
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/result
import gleam/string
import gleam/time/duration
import gleam/time/timestamp.{type Timestamp}
import rays/durable_object.{type Alarm, type Context, type DurableObject}
import rays/durable_object/sql
import rays/retry

/// The `Reminders` class.
pub fn reminders() -> DurableObject(Nil) {
  durable_object.new(Nil)
  |> durable_object.on_wake(fn(wake) {
    let assert Ok(Nil) =
      sql.exec(
        "create table if not exists runs (
          key text not null,
          attempt integer not null,
          idempotency_key text not null,
          overlapped integer not null,
          finished integer not null default 0
        )",
        on: wake.context,
        with: [],
      )
    Nil
  })
  |> durable_object.register_alarm(
    remind,
    id: "remind",
    retry: retry.Fixed(every: duration.milliseconds(10)),
    max_attempts: 3,
    timeout: duration.milliseconds(100),
  )
  |> durable_object.register_alarm(
    linger,
    id: "linger",
    retry: retry.Fixed(every: duration.milliseconds(10)),
    max_attempts: 1,
    timeout: duration.seconds(5),
  )
}

/// Record the attempt, then do what the key starts with:
///
/// - `retry-`: ask to be retried.
/// - `give-up-`: give up.
/// - `panic-`: panic.
/// - `slow-`: take longer than the timeout, then finish.
/// - `hang-`: take much longer than the timeout, then finish.
/// - `reset-`: reset the instance before waiting on anything.
/// - `again-`: schedule itself again an hour after it was due, then finish.
/// - anything else: finish.
pub fn remind(alarm: Alarm(Nil)) -> Promise(durable_object.Outcome) {
  let overlapped = case unfinished(alarm.context, alarm.key) {
    0 -> 0
    _ -> 1
  }
  let assert Ok(Nil) =
    sql.exec(
      "insert into runs (key, attempt, idempotency_key, overlapped) values (?, ?, ?, ?)",
      on: alarm.context,
      with: [
        sql.text(alarm.key),
        sql.int(alarm.attempt),
        sql.text(alarm.idempotency_key),
        sql.int(overlapped),
      ],
    )
  let finish = fn(outcome) {
    let assert Ok(Nil) =
      sql.exec(
        "update runs set finished = 1 where key = ? and attempt = ?",
        on: alarm.context,
        with: [sql.text(alarm.key), sql.int(alarm.attempt)],
      )
    outcome
  }
  case alarm.key {
    "retry-" <> _ -> promise.resolve(finish(durable_object.Retry("asked to")))
    "give-up-" <> _ ->
      promise.resolve(finish(durable_object.GiveUp("asked to")))
    "panic-" <> _ -> panic as "the handler panicked"
    "slow-" <> _ -> {
      use _ <- promise.map(promise.wait(250))
      finish(durable_object.Done)
    }
    "hang-" <> _ -> {
      use _ <- promise.map(promise.wait(2000))
      finish(durable_object.Done)
    }
    "reset-" <> _ -> {
      reset(alarm.context)
      promise.resolve(finish(durable_object.Done))
    }
    "again-" <> _ -> {
      let next = timestamp.add(alarm.scheduled_at, duration.hours(1))
      let assert Ok(Nil) =
        durable_object.schedule_alarm(
          alarm.context,
          remind,
          key: alarm.key,
          at: next,
        )
      promise.resolve(finish(durable_object.Done))
    }
    _ -> promise.resolve(finish(durable_object.Done))
  }
}

fn unfinished(context: Context, key: String) -> Int {
  sql.query(
    "select count(*) from runs where key = ? and finished = 0",
    on: context,
    with: [sql.text(key)],
    expecting: decode.field(0, decode.int, decode.success),
  )
  |> result.unwrap([])
  |> list.first
  |> result.unwrap(0)
}

/// Record the attempt, wait half a second, well within its timeout, then
/// finish.
pub fn linger(alarm: Alarm(Nil)) -> Promise(durable_object.Outcome) {
  let assert Ok(Nil) =
    sql.exec(
      "insert into runs (key, attempt, idempotency_key, overlapped) values (?, ?, ?, 0)",
      on: alarm.context,
      with: [
        sql.text(alarm.key),
        sql.int(alarm.attempt),
        sql.text(alarm.idempotency_key),
      ],
    )
  use _ <- promise.map(promise.wait(500))
  let assert Ok(Nil) =
    sql.exec(
      "update runs set finished = 1 where key = ?",
      on: alarm.context,
      with: [sql.text(alarm.key)],
    )
  durable_object.Done
}

@external(javascript, "./reminders_ffi.mts", "reset")
fn reset(context: Context) -> Nil

/// A handler the class doesn't register.
pub fn unregistered(_alarm: Alarm(Nil)) -> Promise(durable_object.Outcome) {
  promise.resolve(durable_object.Done)
}

// What the tests call inside an instance, with times in milliseconds since
// the Unix epoch. Results are `string.inspect`ed for the tests to compare.

pub fn schedule(context: Context, key: String, at: Int) -> String {
  durable_object.schedule_alarm(
    context,
    remind,
    key:,
    at: from_milliseconds(at),
  )
  |> string.inspect
}

/// Schedule `count` alarms, keyed `prefix` and their number.
pub fn schedule_many(
  context: Context,
  prefix: String,
  count: Int,
  at: Int,
) -> String {
  schedule_many_loop(context, prefix, count, from_milliseconds(at))
  |> string.inspect
}

fn schedule_many_loop(
  context: Context,
  prefix: String,
  count: Int,
  at: Timestamp,
) -> Result(Nil, durable_object.AlarmError) {
  case count {
    0 -> Ok(Nil)
    _ -> {
      let key = prefix <> int.to_string(count)
      use Nil <- result.try(durable_object.schedule_alarm(
        context,
        remind,
        key:,
        at:,
      ))
      schedule_many_loop(context, prefix, count - 1, at)
    }
  }
}

pub fn schedule_linger(context: Context, key: String, at: Int) -> String {
  durable_object.schedule_alarm(
    context,
    linger,
    key:,
    at: from_milliseconds(at),
  )
  |> string.inspect
}

/// Schedule inside a `sql.transaction`.
pub fn schedule_in_transaction(
  context: Context,
  key: String,
  at: Int,
) -> String {
  {
    use <- sql.transaction(context)
    durable_object.schedule_alarm(
      context,
      remind,
      key:,
      at: from_milliseconds(at),
    )
  }
  |> string.inspect
}

pub fn schedule_unregistered(context: Context) -> String {
  durable_object.schedule_alarm(
    context,
    unregistered,
    key: "",
    at: from_milliseconds(0),
  )
  |> string.inspect
}

pub fn cancel(context: Context, key: String) -> String {
  durable_object.cancel_alarm(context, remind, key:)
  |> string.inspect
}

/// The next time, in milliseconds, or -1 if it isn't pending.
pub fn next(context: Context, key: String) -> Int {
  case durable_object.next_alarm(context, remind, key:) {
    Ok(at) -> to_milliseconds(at)
    Error(Nil) -> -1
  }
}

fn from_milliseconds(milliseconds: Int) -> Timestamp {
  timestamp.from_unix_seconds_and_nanoseconds(
    milliseconds / 1000,
    milliseconds % 1000 * 1_000_000,
  )
}

fn to_milliseconds(at: Timestamp) -> Int {
  let #(seconds, nanoseconds) = timestamp.to_unix_seconds_and_nanoseconds(at)
  seconds * 1000 + nanoseconds / 1_000_000
}
