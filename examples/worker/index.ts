import { main } from "./build/dev/javascript/worker_example/worker.mjs";

const worker: ExportedHandler<Env> = main();

export default worker;
