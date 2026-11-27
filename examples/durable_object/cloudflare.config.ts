// The app is one Worker, from `pub fn app()` in src/rooms.gleam, which hosts
// the `ChatRoom` Durable Object class in src/rooms/chat_room.gleam.
// `raysApp()` calls it and configures the Worker: it exports `ChatRoom`,
// with SQLite storage, and is bound to it, so the Gleam code reaches it with
// `app.connect_durable_object` and never names a binding.
//
// `pub fn chat_room()` is the class `ChatRoom`. To rename or remove the
// function later, keep `ChatRoom` in the Worker's `exports` with
// `state: "renamed"` or `state: "deleted"`, by passing
// `workers: { rooms: { exports: { ... } } }` to `raysApp()`, so its stored
// data isn't lost.
import { raysApp } from "@rays/config/app";
import { defineConfig } from "cf/config";

const app = await raysApp({ compatibilityDate: "2026-09-01" });

export default defineConfig({ worker: app.main });
