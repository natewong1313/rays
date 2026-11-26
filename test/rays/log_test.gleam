//// Tests for `rays/log`: which `console` method each level uses, the values
//// passed to it, loggers' fields, and the minimum level.

import gleam/json
import rays/log

/// Each `console` call made while running `run`: the method name and its
/// arguments as a JSON array.
@external(javascript, "./log_test_ffi.mts", "captureConsole")
fn capture_console(run: fn() -> a) -> List(#(String, String))

/// Run `run` with the minimum level set, then put back the default.
fn with_level(level: log.Level, run: fn() -> a) -> a {
  log.set_level(level)
  let result = run()
  log.set_level(log.Debug)
  result
}

pub fn levels_use_matching_console_methods_test() {
  let calls =
    capture_console(fn() {
      log.debug("a", [])
      log.info("b", [])
      log.warning("c", [])
      log.error("d", [])
    })
  assert calls
    == [
      #("debug", "[\"a\"]"),
      #("info", "[\"b\"]"),
      #("warn", "[\"c\"]"),
      #("error", "[\"d\"]"),
    ]
}

pub fn fields_write_object_test() {
  let calls =
    capture_console(fn() {
      log.warning("Rate limit reached", [
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
      log.error("real", [#("message", json.string("field"))])
    })
  assert calls == [#("error", "[{\"message\":\"real\"}]")]
}

// Loggers

pub fn logger_fields_come_first_test() {
  let logger =
    log.new()
    |> log.with_fields([#("request_id", json.string("abc"))])
    |> log.with_fields([#("room", json.string("lobby"))])
  let calls =
    capture_console(fn() {
      log.log(logger, log.Info, "Joined", [#("user_id", json.int(1))])
    })
  assert calls
    == [
      #(
        "info",
        "[{\"request_id\":\"abc\",\"room\":\"lobby\",\"user_id\":1,\"message\":\"Joined\"}]",
      ),
    ]
}

pub fn logger_with_only_its_fields_writes_object_test() {
  let logger = log.new() |> log.with_fields([#("room", json.string("lobby"))])
  let calls = capture_console(fn() { log.log(logger, log.Debug, "Tick", []) })
  assert calls == [#("debug", "[{\"room\":\"lobby\",\"message\":\"Tick\"}]")]
}

pub fn later_fields_replace_earlier_test() {
  let logger =
    log.new()
    |> log.with_fields([#("room", json.string("lobby"))])
    |> log.with_fields([#("room", json.string("kitchen"))])
  let calls =
    capture_console(fn() {
      log.log(logger, log.Info, "a", [])
      log.log(logger, log.Info, "b", [#("room", json.string("attic"))])
    })
  assert calls
    == [
      #("info", "[{\"room\":\"kitchen\",\"message\":\"a\"}]"),
      #("info", "[{\"room\":\"attic\",\"message\":\"b\"}]"),
    ]
}

// Minimum level

pub fn default_level_writes_everything_test() {
  assert log.is_enabled(log.Debug)
  assert log.is_enabled(log.Error)
}

pub fn set_level_drops_less_severe_logs_test() {
  let calls =
    with_level(log.Warning, fn() {
      capture_console(fn() {
        log.debug("a", [])
        log.info("b", [])
        log.warning("c", [])
        log.log(log.new(), log.Info, "d", [])
        log.log(log.new(), log.Error, "e", [])
      })
    })
  assert calls == [#("warn", "[\"c\"]"), #("error", "[\"e\"]")]
}

pub fn is_enabled_follows_level_test() {
  let enabled =
    with_level(log.Info, fn() {
      #(log.is_enabled(log.Debug), log.is_enabled(log.Info))
    })
  assert enabled == #(False, True)
}
