//// The `rays/durable_object/sql` module docs' example class, which keeps
//// notes in its database, created by the migrations in
//// `src/integration_tests/notes/migrations/`.

import gleam/dynamic/decode
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/result
import integration_tests/notes/migrations
import rays/durable_object.{type DurableObject, type Params}
import rays/durable_object/sql

/// The `Notes` class.
pub fn notes() -> DurableObject(Nil) {
  durable_object.new(Nil)
  |> durable_object.on_wake(fn(wake) {
    let assert Ok(_) = sql.migrate(wake.context, migrations.all)
    Nil
  })
  |> durable_object.bind(add)
  |> durable_object.bind(recent)
}

/// Add a note, and reply with its id.
pub fn add(params: Params(String, Nil)) -> Promise(Result(Int, Nil)) {
  sql.query(
    "insert into notes (body) values (?) returning id",
    on: params.context,
    with: [sql.text(params.args)],
    expecting: decode.field(0, decode.int, decode.success),
  )
  |> result.replace_error(Nil)
  |> result.try(list.first)
  |> promise.resolve
}

/// Reply with the latest notes, newest first.
pub fn recent(params: Params(Int, Nil)) -> Promise(List(String)) {
  sql.query(
    "select body from notes order by id desc limit ?",
    on: params.context,
    with: [sql.int(params.args)],
    expecting: decode.field(0, decode.string, decode.success),
  )
  |> result.unwrap([])
  |> promise.resolve
}
