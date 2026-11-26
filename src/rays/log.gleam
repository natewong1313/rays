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
//// log.info("Server started")
////
//// log.log(log.Warning, "Rate limit reached", [
////   #("user_id", json.int(42)),
////   #("limit", json.int(100)),
//// ])
//// // console.warn({ user_id: 42, limit: 100, message: "Rate limit reached" })
//// ```
////
//// Workers Logs already records every request's method, URL, status, and
//// uncaught exceptions, so there is no need to log those yourself. To see
//// logs from a deployed Worker, enable `observability` in its Wrangler
//// configuration.
////
//// Every level is always written; filter by level in the dashboard.

import gleam/json.{type Json}
import gleam/list

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

/// Write a log at the given level, with structured fields.
///
/// With no fields, the message is written as a plain string. Otherwise the
/// log is a JSON object holding the fields and the message under the
/// `"message"` key; a field named `"message"` is replaced by the message.
///
/// # Examples
///
/// ```gleam
/// log.log(log.Info, "User signed in", [
///   #("user_id", json.int(42)),
///   #("method", json.string("passkey")),
/// ])
/// ```
///
pub fn log(
  level: Level,
  message: String,
  fields: List(#(String, Json)),
) -> Nil {
  let method = console_method(level)
  case fields {
    [] -> js_write_text(method, message)
    _ ->
      // The message goes last so it wins over a field with the same name,
      // as the later of two duplicate keys wins in `JSON.parse`.
      list.append(fields, [#("message", json.string(message))])
      |> json.object
      |> json.to_string
      |> js_write_json(method, _)
  }
}

/// Write a debug log. The same as `log(Debug, message, [])`.
///
pub fn debug(message: String) -> Nil {
  log(Debug, message, [])
}

/// Write an info log. The same as `log(Info, message, [])`.
///
pub fn info(message: String) -> Nil {
  log(Info, message, [])
}

/// Write a warning log. The same as `log(Warning, message, [])`.
///
pub fn warning(message: String) -> Nil {
  log(Warning, message, [])
}

/// Write an error log. The same as `log(Error, message, [])`.
///
pub fn error(message: String) -> Nil {
  log(Error, message, [])
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
