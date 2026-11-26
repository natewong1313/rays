// One Worker, which also defines the Durable Object class in
// src/rooms/chat_room.gleam. `pub fn chat_room()` is the class `ChatRoom`,
// declared in `exports` like any Durable Object class, so the Worker reaches
// it through `ctx.exports`, without a binding. To rename or remove the
// function later, keep `ChatRoom` here with `state: "renamed"` or
// `state: "deleted"`, so its stored data isn't lost.
import { raysWorker } from "@rays/config/cf";
import { defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: raysWorker({
    name: "rays-durable-object",
    compatibilityDate: "2026-09-01",
    exports: {
      ChatRoom: exports.durableObject({ storage: "sqlite" }),
    },
  }),
});
