// Cloudflare entry module for the Gleam Worker. Gleam can't emit
// `export default`, so this file exports the Worker built by `main` in
// src/api.gleam.
import { handler } from "@rays/core/runtime";
import { main } from "./build/dev/javascript/api/api.mjs";

export default handler(main());
