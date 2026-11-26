//// Write logs from a Worker or Durable Object to
//// [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
//// `wrangler tail`, and the `wrangler dev` terminal.
////
//// Each level is written with the matching `console` method, so logs show at
//// the right severity in the Cloudflare dashboard. Logs with fields are
//// written as JSON objects, which Workers Logs indexes field by field, so you
//// can filter on `user_id` instead of searching message text.
////
//// ```gleam
//// import gleam/json
//// import rays/log
////
//// log.info("Cache warmed", [])
////
//// log.warning("Rate limit reached", [
////   #("user_id", json.int(42)),
////   #("limit", json.int(100)),
//// ])
//// // console.warn({ user_id: 42, limit: 100, message: "Rate limit reached" })
//// ```
////
//// To add the same fields to every log for a request, such as its ID, build
//// a `Logger` and pass it to the code handling the request:
////
//// ```gleam
//// let logger =
////   log.new()
////   |> log.with_fields([#("request_id", json.string(request_id))])
////
//// log.log(logger, log.Info, "User signed in", [#("user_id", json.int(42))])
//// // console.info({ request_id: "…", user_id: 42, message: "User signed in" })
//// ```
////
//// A `Logger` is a plain value, so concurrent requests in the same isolate
//// each keep their own fields.
////
//// Workers Logs already records every request's method, URL, status, and
//// uncaught exceptions, so there is no need to log those yourself. To see
//// logs from a deployed Worker, enable `observability` in its Wrangler
//// configuration.

import gleam/json.{type Json}
import gleam/list

//
// Levels
//

/// How severe a log is. Each level is written with its own `console` method.
///
pub type Level {
  /// Detail for debugging, written with `console.debug`.
  Debug
  /// Normal operation, written with `console.info`.
  Info
  /// Something unexpected that the Worker recovered from, written with
  /// `console.warn`.
  Warning
  /// A failure, written with `console.error`.
  Error
}

/// Only write logs at the given level or more severe ones. For example,
/// `set_level(Info)` drops debug logs. The default is `Debug`, which writes
/// everything.
///
/// The level applies to the whole isolate, which serves many requests, so
/// call this when the module loads, for example in `main`, rather than in a
/// handler. Dropping debug logs in production saves on the 256 KB of logs
/// each invocation may write and on Workers Logs events.
///
/// # Examples
///
/// ```gleam
/// pub fn main() -> worker.Worker {
///   log.set_level(log.Info)
///   worker.new(handle_request)
/// }
/// ```
///
pub fn set_level(level: Level) -> Nil {
  js_set_minimum_rank(rank(level))
}

/// Whether logs at the given level are written under the level set with
/// `set_level`. Use it to skip building fields that are costly to compute.
///
pub fn is_enabled(level: Level) -> Bool {
  rank(level) >= js_minimum_rank()
}

fn rank(level: Level) -> Int {
  case level {
    Debug -> 0
    Info -> 1
    Warning -> 2
    Error -> 3
  }
}

//
// Loggers
//

/// Fields added to every log written with it. Build one with `new` and
/// `with_fields`.
///
pub opaque type Logger {
  Logger(fields: List(#(String, Json)))
}

/// A logger with no fields of its own.
///
pub fn new() -> Logger {
  Logger(fields: [])
}

/// Add fields to every log written with the logger. A field with the same
/// name as one already on the logger replaces it.
///
/// # Examples
///
/// ```gleam
/// let logger =
///   log.new()
///   |> log.with_fields([#("room", json.string(room_name))])
/// ```
///
pub fn with_fields(logger: Logger, fields: List(#(String, Json))) -> Logger {
  Logger(fields: list.append(logger.fields, fields))
}

//
// Writing
//

/// Write a log at the given level with the logger's fields and the given
/// fields. Nothing is written if the level is below the one set with
/// `set_level`.
///
/// With no fields at all, the message is written as a plain string.
/// Otherwise the log is a JSON object holding the fields and the message
/// under the `"message"` key. Where names clash, the given fields replace the
/// logger's, and the message replaces a field named `"message"`.
///
/// # Examples
///
/// ```gleam
/// log.log(logger, log.Info, "User signed in", [
///   #("user_id", json.int(42)),
///   #("method", json.string("passkey")),
/// ])
/// ```
///
pub fn log(
  logger: Logger,
  level: Level,
  message: String,
  fields: List(#(String, Json)),
) -> Nil {
  case is_enabled(level) {
    False -> Nil
    True -> write(level, message, list.append(logger.fields, fields))
  }
}

/// Write a debug log. The same as `log(new(), Debug, message, fields)`.
///
pub fn debug(message: String, fields: List(#(String, Json))) -> Nil {
  log(new(), Debug, message, fields)
}

/// Write an info log. The same as `log(new(), Info, message, fields)`.
///
/// # Examples
///
/// ```gleam
/// log.info("Cache warmed", [#("entries", json.int(120))])
/// ```
///
pub fn info(message: String, fields: List(#(String, Json))) -> Nil {
  log(new(), Info, message, fields)
}

/// Write a warning log. The same as `log(new(), Warning, message, fields)`.
///
pub fn warning(message: String, fields: List(#(String, Json))) -> Nil {
  log(new(), Warning, message, fields)
}

/// Write an error log. The same as `log(new(), Error, message, fields)`.
///
pub fn error(message: String, fields: List(#(String, Json))) -> Nil {
  log(new(), Error, message, fields)
}

fn write(level: Level, message: String, fields: List(#(String, Json))) -> Nil {
  let method = console_method(level)
  case fields {
    [] -> js_write_text(method, message)
    _ ->
      // Later fields win because the later of two duplicate keys wins in
      // `JSON.parse`, so the message goes last.
      list.append(fields, [#("message", json.string(message))])
      |> json.object
      |> json.to_string
      |> js_write_json(method, _)
  }
}

/// The name of the `console` method that writes logs at a level.
///
fn console_method(level: Level) -> String {
  case level {
    Debug -> "debug"
    Info -> "info"
    Warning -> "warn"
    Error -> "error"
  }
}

//
// FFI
//

@external(javascript, "./log_ffi.mts", "writeText")
fn js_write_text(method: String, message: String) -> Nil

@external(javascript, "./log_ffi.mts", "writeJson")
fn js_write_json(method: String, json: String) -> Nil

@external(javascript, "./log_ffi.mts", "setMinimumRank")
fn js_set_minimum_rank(rank: Int) -> Nil

@external(javascript, "./log_ffi.mts", "minimumRank")
fn js_minimum_rank() -> Int
