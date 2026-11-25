//// A chat room. Each instance is one room, and its memory is the room's
//// messages, newest first. Memory doesn't outlive an eviction, so the room
//// is empty again after one.

import gleam/javascript/promise.{type Promise}
import gleam/list
import rays/durable_object.{type DurableObject, type Params}

pub type Room {
  Room(messages: List(String))
}

/// The `ChatRoom` class.
pub fn chat_room() -> DurableObject(Room) {
  durable_object.new(Room(messages: []))
  |> durable_object.bind(post)
  |> durable_object.bind(recent)
}

/// Post a message, and reply with how many the room has.
pub fn post(params: Params(String, Room)) -> Promise(Int) {
  let room =
    durable_object.update_memory(params.memory, fn(room) {
      Room(messages: [params.args, ..room.messages])
    })
  promise.resolve(list.length(room.messages))
}

/// Reply with the latest messages, newest first.
pub fn recent(params: Params(Int, Room)) -> Promise(List(String)) {
  durable_object.read_memory(params.memory).messages
  |> list.take(params.args)
  |> promise.resolve
}
