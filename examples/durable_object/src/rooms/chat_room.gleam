//// A chat room. Each instance is one room, and keeps the room's messages in
//// its SQLite database, so they outlive an eviction. The database's tables
//// are created by the migrations in `src/rooms/chat_room/migrations/`,
//// which rays hands to this class when it builds the project.
////
//// The room applies them only once a call needs its tables, after checks
//// that don't, so a call it rejects never writes to its storage: a room
//// that has only been sent empty messages isn't stored at all.

import gleam/bool
import gleam/dynamic/decode
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/result
import gleam/string
import rays/durable_object.{type DurableObject, type Params}
import rays/durable_object/sql

/// The `ChatRoom` class. Its memory is `Nil`, as everything it keeps is in
/// its database.
pub fn chat_room() -> DurableObject(Nil) {
  durable_object.new(Nil)
  |> durable_object.bind(post)
  |> durable_object.bind(recent)
}

/// Why a message wasn't posted.
pub type PostError {
  /// The message is empty, or only whitespace.
  EmptyMessage
  /// The room couldn't migrate or query its database.
  StorageFailed
}

/// Post a message, and reply with how many the room has.
pub fn post(params: Params(String, Nil)) -> Promise(Result(Int, PostError)) {
  {
    // Checked before the room touches its database.
    use <- bool.guard(
      when: string.trim(params.args) == "",
      return: Error(EmptyMessage),
    )
    use _ <- result.try(
      sql.apply_migrations(params.context)
      |> result.replace_error(StorageFailed),
    )
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
    |> result.replace_error(StorageFailed)
    |> result.try(fn(counts) {
      list.first(counts) |> result.replace_error(StorageFailed)
    })
  }
  |> promise.resolve
}

/// Reply with the latest messages, newest first.
pub fn recent(params: Params(Int, Nil)) -> Promise(Result(List(String), Nil)) {
  {
    use _ <- result.try(
      sql.apply_migrations(params.context) |> result.replace_error(Nil),
    )
    sql.query(
      "select body from messages order by id desc limit ?",
      on: params.context,
      with: [sql.int(params.args)],
      expecting: decode.field(0, decode.string, decode.success),
    )
    |> result.replace_error(Nil)
  }
  |> promise.resolve
}
