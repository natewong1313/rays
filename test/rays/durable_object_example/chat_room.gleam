//// The `rays/durable_object` module docs' example class, compiled here so
//// it keeps compiling. examples/durable_object runs the same class in the
//// Workers runtime.

import gleam/javascript/promise.{type Promise}
import gleam/list
import rays/durable_object.{type DurableObject, type Params}

pub type Room {
  Room(messages: List(String))
}

pub fn chat_room() -> DurableObject(Room) {
  durable_object.new(Room(messages: []))
  |> durable_object.bind(post)
  |> durable_object.bind(recent)
}

pub fn post(params: Params(String, Room)) -> Promise(Int) {
  let room =
    durable_object.update_memory(params.memory, fn(room) {
      Room(messages: [params.args, ..room.messages])
    })
  promise.resolve(list.length(room.messages))
}

pub fn recent(params: Params(Int, Room)) -> Promise(List(String)) {
  durable_object.read_memory(params.memory).messages
  |> list.take(params.args)
  |> promise.resolve
}
