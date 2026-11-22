// A stand-in for the Workers runtime's `cloudflare:workers` module, so entry
// modules that serve RPC methods can be loaded in Node.js. Only what the
// entry modules use.

export class WorkerEntrypoint {
  protected ctx: unknown;
  protected env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
