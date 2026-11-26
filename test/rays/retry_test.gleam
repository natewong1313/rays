import gleam/list
import gleam/time/duration
import rays/retry

pub fn fixed_delay_test() {
  let backoff = retry.Fixed(every: duration.seconds(30))
  assert list.map([1, 2, 10], retry.delay(backoff, after: _))
    == [duration.seconds(30), duration.seconds(30), duration.seconds(30)]
}

pub fn exponential_delay_doubles_up_to_max_test() {
  let backoff =
    retry.Exponential(first: duration.seconds(2), max: duration.seconds(10))
  assert list.map([1, 2, 3, 4, 5], retry.delay(backoff, after: _))
    == [
      duration.seconds(2),
      duration.seconds(4),
      duration.seconds(8),
      duration.seconds(10),
      duration.seconds(10),
    ]
}

pub fn exponential_delay_after_many_attempts_is_max_test() {
  let backoff =
    retry.Exponential(first: duration.seconds(1), max: duration.hours(1))
  assert retry.delay(backoff, after: 10_000) == duration.hours(1)
}

pub fn validate_test() {
  assert retry.validate(retry.Fixed(every: duration.seconds(0))) == Ok(Nil)
  assert retry.validate(retry.Fixed(every: duration.seconds(-1)))
    == Error("a Fixed backoff can't wait a negative time")
  assert retry.validate(retry.Exponential(
      first: duration.seconds(1),
      max: duration.seconds(1),
    ))
    == Ok(Nil)
  assert retry.validate(retry.Exponential(
      first: duration.seconds(0),
      max: duration.seconds(1),
    ))
    == Error("an Exponential backoff's first wait must be above zero")
  assert retry.validate(retry.Exponential(
      first: duration.seconds(2),
      max: duration.seconds(1),
    ))
    == Error("an Exponential backoff's first wait can't be more than its max")
}
