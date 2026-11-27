//// Tests for `rays/durable_object/sql` that run without the Workers
//// runtime. Queries, transactions and migrations are tested in the runtime
//// in `packages/integration-tests`.

import gleam/option.{None, Some}
import rays/durable_object/sql.{QueryFailed}

pub fn query_failed_with_extended_code_test() {
  assert sql.query_failed(
      "UNIQUE constraint failed: people.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
    )
    == QueryFailed(
      code: Some("SQLITE_CONSTRAINT_UNIQUE"),
      message: "UNIQUE constraint failed: people.name",
    )
}

pub fn query_failed_with_primary_code_test() {
  assert sql.query_failed(
      "near \"SELEC\": syntax error at offset 0: SQLITE_ERROR",
    )
    == QueryFailed(
      code: Some("SQLITE_ERROR"),
      message: "near \"SELEC\": syntax error at offset 0",
    )
}

pub fn query_failed_with_empty_message_test() {
  assert sql.query_failed(": SQLITE_ERROR")
    == QueryFailed(code: Some("SQLITE_ERROR"), message: "")
}

pub fn query_failed_without_code_test() {
  assert sql.query_failed("Wrong number of parameter bindings for SQL query.")
    == QueryFailed(
      code: None,
      message: "Wrong number of parameter bindings for SQL query.",
    )
  assert sql.query_failed("not a code: sqlite_error")
    == QueryFailed(code: None, message: "not a code: sqlite_error")
}

pub fn query_failed_with_malformed_extended_code_test() {
  assert sql.query_failed("bad: SQLITE_CONSTRAINT (extended: nope)")
    == QueryFailed(
      code: None,
      message: "bad: SQLITE_CONSTRAINT (extended: nope)",
    )
}

pub fn nullable_test() {
  assert sql.nullable(sql.int, None) == sql.null()
  assert sql.nullable(sql.int, Some(1)) == sql.int(1)
}
