//// A Worker with chat rooms. Each room is an instance of the `ChatRoom`
//// Durable Object class, named after the room, which the Worker reaches
//// through `ctx.exports`.

import gleam/http.{Get, Post}
import gleam/int
import gleam/javascript/promise.{type Promise}
import gleam/string
import rays/durable_object.{type CallError}
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
  case durable_object.exported(ctx, chat_room.chat_room) {
    Ok(rooms) ->
      case request.method, worker.path_segments(request) {
        // Post a message, and reply with how many the room has.
        Post, ["rooms", name] -> {
          use message <- worker.require_string_body(request)
          let room = durable_object.get_by_name(rooms, name)
          use count <- reply(durable_object.call(room, chat_room.post, message))
          int.to_string(count)
        }
        // Reply with the room's latest messages, newest first.
        Get, ["rooms", name] -> {
          let room = durable_object.get_by_name(rooms, name)
          use messages <- reply(durable_object.call(room, chat_room.recent, 10))
          string.join(messages, "\n")
        }
        _, _ -> promise.resolve(worker.not_found())
      }
    // This Worker's configuration doesn't declare the class.
    Error(Nil) -> promise.resolve(worker.internal_server_error())
  }
}

// Respond with the reply of a call, or with a 502 if the call failed.
fn reply(
  call: Promise(Result(a, CallError)),
  body: fn(a) -> String,
) -> Promise(Response) {
  use result <- promise.map(call)
  case result {
    Ok(value) -> worker.ok() |> worker.string_body(body(value))
    Error(_) -> worker.response(502)
  }
}
