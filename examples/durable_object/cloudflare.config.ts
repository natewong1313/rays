// One Worker, which also defines the Durable Object class in
// src/rooms/chat_room.gleam. `raysWorker()` declares every class in the
// project in the Worker's `exports`, so the Worker reaches ChatRoom through
// `ctx.exports`, without a binding.
import { raysWorker } from "@rays/config/cf";
import { defineConfig } from "cf/config";

export default defineConfig({
  worker: raysWorker({
    name: "rays-durable-object",
    compatibilityDate: "2026-09-01",
  }),
});
