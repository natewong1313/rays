//// A Worker with chat rooms. Each room is an instance of the `ChatRoom`
//// Durable Object class, named after the room, which the Worker reaches
//// through `ctx.exports`. A room keeps its messages in its SQLite database.

import gleam/http.{Get, Post}
import gleam/int
import gleam/javascript/promise.{type Promise}
import gleam/string
import rays/durable_object.{type Namespace}
import rays/worker.{type Context, type Env, type Request, type Response}
import rooms/chat_room

pub fn main() -> worker.Worker {
  worker.new(handle_request)
}

pub fn handle_request(
  request: Request,
  _env: Env,
  ctx: Context,
) -> Promise(Response) {
  let assert Ok(rooms) = durable_object.exported(ctx, chat_room.chat_room)

  case request.method, worker.path_segments(request) {
    Post, ["rooms", name] -> post_message(request, rooms, name)
    Get, ["rooms", name] -> get_latest_message(rooms, name)
    _, _ -> promise.resolve(worker.not_found())
  }
}

// Post a message to a room, and reply with how many the room has.
fn post_message(
  request: Request,
  rooms: Namespace(Nil),
  name: String,
) -> Promise(Response) {
  use message <- worker.require_string_body(request)
  let room = durable_object.get_by_name(rooms, name)
  use result <- promise.map(durable_object.call(room, chat_room.post, message))
  // A 400 for an empty message, a 500 if the room couldn't use its
  // database, and a 502 if the call failed.
  case result {
    Ok(Ok(count)) -> worker.ok() |> worker.string_body(int.to_string(count))
    Ok(Error(chat_room.EmptyMessage)) -> worker.response(400)
    Ok(Error(chat_room.StorageFailed)) -> worker.internal_server_error()
    Error(_) -> worker.response(502)
  }
}

// Reply with a room's latest messages, newest first.
fn get_latest_message(
  rooms: Namespace(Nil),
  name: String,
) -> Promise(Response) {
  let room = durable_object.get_by_name(rooms, name)
  use result <- promise.map(durable_object.call(room, chat_room.recent, 10))
  // A 500 if the room couldn't query its database, a 502 if the call failed.
  case result {
    Ok(Ok(messages)) ->
      worker.ok() |> worker.string_body(string.join(messages, "\n"))
    Ok(Error(Nil)) -> worker.internal_server_error()
    Error(_) -> worker.response(502)
  }
}
