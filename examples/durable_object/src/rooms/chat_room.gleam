//// A chat room. Each instance is one room, and keeps the room's messages in
//// its SQLite database, so they outlive an eviction. The database's tables
//// are created by the migrations in `src/rooms/chat_room/migrations/`,
//// which rays writes into the `rooms/chat_room/migrations` module.

import gleam/dynamic/decode
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/result
import rays/durable_object.{type DurableObject, type Params}
import rays/durable_object/sql
import rooms/chat_room/migrations

/// The `ChatRoom` class. Its memory is `Nil`, as everything it keeps is in
/// its database.
pub fn chat_room() -> DurableObject(Nil) {
  durable_object.new(Nil)
  |> durable_object.on_wake(fn(wake) {
    // Before any call, so every call sees the tables. A failed migration
    // stops the room waking, and the next call tries again.
    let assert Ok(_) = sql.migrate(wake.context, migrations.all)
    Nil
  })
  |> durable_object.bind(post)
  |> durable_object.bind(recent)
}

/// Post a message, and reply with how many the room has.
pub fn post(params: Params(String, Nil)) -> Promise(Result(Int, Nil)) {
  {
    use _ <- result.try(
      sql.exec(
        "insert into messages (body) values (?)",
        on: params.context,
        with: [sql.text(params.args)],
      ),
    )
    sql.query(
      "select count(*) from messages",
      on: params.context,
      with: [],
      expecting: decode.field(0, decode.int, decode.success),
    )
  }
  |> result.replace_error(Nil)
  |> result.try(list.first)
  |> promise.resolve
}

/// Reply with the latest messages, newest first.
pub fn recent(params: Params(Int, Nil)) -> Promise(Result(List(String), Nil)) {
  sql.query(
    "select body from messages order by id desc limit ?",
    on: params.context,
    with: [sql.int(params.args)],
    expecting: decode.field(0, decode.string, decode.success),
  )
  |> result.replace_error(Nil)
  |> promise.resolve
}
