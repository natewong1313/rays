//// The Alarms example in `rays/durable_object`'s module docs, compiled to
//// check it. `send_reminder` stands in for a call to an email service.

import gleam/javascript/promise.{type Promise}
import gleam/time/duration
import gleam/time/timestamp.{type Timestamp}
import rays/durable_object.{type Alarm, type DurableObject, type Params}
import rays/retry
import rays/worker.{type Env}

pub fn reminders() -> DurableObject(Nil) {
  durable_object.new(Nil)
  |> durable_object.bind(remind_me)
  |> durable_object.register_alarm(
    remind,
    id: "remind",
    retry: retry.Fixed(every: duration.minutes(1)),
    max_attempts: 3,
    timeout: duration.seconds(30),
  )
}

pub fn remind_me(
  params: Params(#(String, Timestamp), Nil),
) -> Promise(Result(Nil, durable_object.AlarmError)) {
  let #(user_id, at) = params.args
  durable_object.schedule_alarm(params.context, remind, key: user_id, at:)
  |> promise.resolve
}

pub fn remind(alarm: Alarm(Nil)) -> Promise(durable_object.Outcome) {
  use sent <- promise.map(send_reminder(alarm.env, alarm.key))
  case sent {
    Ok(Nil) -> durable_object.Done
    Error(reason) -> durable_object.Retry(reason:)
  }
}

fn send_reminder(_env: Env, _user_id: String) -> Promise(Result(Nil, String)) {
  promise.resolve(Ok(Nil))
}
