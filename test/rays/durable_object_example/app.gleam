//// The `rays/durable_object` module docs' example Worker, compiled here so
//// it keeps compiling.

import gleam/int
import gleam/javascript/promise.{type Promise}
import rays/app
import rays/durable_object
import rays/durable_object_example/chat_room
import rays/worker.{type Context, type Env, type Request, type Response}

pub fn handle_request(
  _request: Request,
  _env: Env,
  _ctx: Context,
) -> Promise(Response) {
  case app.connect_durable_object(chat_room.chat_room) {
    Ok(rooms) -> {
      let room = durable_object.get_by_name(rooms, "general")
      let posted = durable_object.call(room, chat_room.post, "Hello!")
      use posted <- promise.map(posted)
      case posted {
        Ok(count) -> worker.ok() |> worker.string_body(int.to_string(count))
        Error(_) -> worker.response(502)
      }
    }
    Error(Nil) -> promise.resolve(worker.internal_server_error())
  }
}
