// Cloudflare entry module. Gleam can't emit `export default`, so this file
// re-exports the Worker built by `main` in src/worker.gleam.
import { main } from "./build/dev/javascript/worker_example/worker.mjs";

export default main();
