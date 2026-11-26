//// Tests for `rays/log`: which `console` method each level uses, and the
//// values passed to it.

import gleam/json
import rays/log

/// Each `console` call made while running `run`: the method name and its
/// arguments as a JSON array.
@external(javascript, "./log_test_ffi.mts", "captureConsole")
fn capture_console(run: fn() -> a) -> List(#(String, String))

pub fn levels_use_matching_console_methods_test() {
  let calls =
    capture_console(fn() {
      log.debug("a")
      log.info("b")
      log.warning("c")
      log.error("d")
    })
  assert calls
    == [
      #("debug", "[\"a\"]"),
      #("info", "[\"b\"]"),
      #("warn", "[\"c\"]"),
      #("error", "[\"d\"]"),
    ]
}

pub fn log_without_fields_writes_text_test() {
  let calls = capture_console(fn() { log.log(log.Info, "hello", []) })
  assert calls == [#("info", "[\"hello\"]")]
}

pub fn log_with_fields_writes_object_test() {
  let calls =
    capture_console(fn() {
      log.log(log.Warning, "Rate limit reached", [
        #("user_id", json.int(42)),
        #("tags", json.array(["a", "b"], json.string)),
      ])
    })
  assert calls
    == [
      #(
        "warn",
        "[{\"user_id\":42,\"tags\":[\"a\",\"b\"],\"message\":\"Rate limit reached\"}]",
      ),
    ]
}

pub fn message_replaces_message_field_test() {
  let calls =
    capture_console(fn() {
      log.log(log.Error, "real", [#("message", json.string("field"))])
    })
  assert calls == [#("error", "[{\"message\":\"real\"}]")]
}
