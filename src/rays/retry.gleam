//// How long to wait before trying again something that failed, such as a
//// Durable Object alarm registered with `durable_object.register_alarm`.
////
//// ```gleam
//// import gleam/time/duration
//// import rays/retry
////
//// // 2s, 4s, 8s, ... and then 10 minutes between every attempt.
//// retry.Exponential(first: duration.seconds(2), max: duration.minutes(10))
////
//// // A minute between every attempt.
//// retry.Fixed(every: duration.minutes(1))
//// ```

import gleam/order
import gleam/time/duration.{type Duration}

/// How long to wait between attempts of work that failed.
///
pub type Backoff {
  /// Wait `first` after the first failed attempt, then twice as long after
  /// each one after it, up to `max`.
  Exponential(first: Duration, max: Duration)
  /// Wait the same time after every failed attempt.
  Fixed(every: Duration)
}

/// How long to wait after the given attempt failed, counting the first
/// attempt as 1, before making the next one.
///
/// # Examples
///
/// ```gleam
/// let backoff =
///   retry.Exponential(first: duration.seconds(2), max: duration.seconds(5))
/// retry.delay(backoff, after: 1)
/// // -> duration.seconds(2)
/// retry.delay(backoff, after: 2)
/// // -> duration.seconds(4)
/// retry.delay(backoff, after: 3)
/// // -> duration.seconds(5)
/// ```
///
pub fn delay(backoff: Backoff, after attempt: Int) -> Duration {
  case backoff {
    Fixed(every:) -> every
    Exponential(first:, max:) -> double_loop(first, max, attempt - 1)
  }
}

// Double `wait` `times` times, stopping at `max`. It stops as soon as `max`
// is reached rather than doubling `times` times, so a high attempt number
// doesn't overflow.
fn double_loop(wait: Duration, max: Duration, times: Int) -> Duration {
  case duration.compare(wait, max) {
    order.Gt | order.Eq -> max
    order.Lt if times <= 0 -> wait
    order.Lt -> double_loop(duration.add(wait, wait), max, times - 1)
  }
}

/// Check that a backoff's durations make sense: none is negative, and an
/// `Exponential` one's `first` is above zero and no more than its `max`.
///
/// Returns an error saying what is wrong.
///
pub fn validate(backoff: Backoff) -> Result(Nil, String) {
  // In milliseconds: `duration.compare` compares how long durations are,
  // whatever their sign, so it can't tell a negative one.
  case backoff {
    Fixed(every:) ->
      case duration.to_milliseconds(every) < 0 {
        True -> Error("a Fixed backoff can't wait a negative time")
        False -> Ok(Nil)
      }
    Exponential(first:, max:) -> {
      let first = duration.to_milliseconds(first)
      case first <= 0, first > duration.to_milliseconds(max) {
        True, _ ->
          Error("an Exponential backoff's first wait must be above zero")
        False, True ->
          Error(
            "an Exponential backoff's first wait can't be more than its max",
          )
        False, False -> Ok(Nil)
      }
    }
  }
}
