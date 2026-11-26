// Types for the modules made by the `rays()` Vite plugin from
// `@rays/config/vite`. Add them to a project with
// `"types": ["@rays/config/virtual"]` in tsconfig.json, or
// `/// <reference types="@rays/config/virtual" />`.
//
// They don't depend on the Workers runtime types, so they work with either
// `wrangler types` or `@cloudflare/workers-types`.

/** The Worker returned by `pub fn main()` in the package's own module. */
declare module "virtual:rays/worker" {
  const worker: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  export default worker;
}

/** The Worker returned by `pub fn main()` in the named module. */
declare module "virtual:rays/worker/*" {
  const worker: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  export default worker;
}

/**
 * A Worker with the Durable Object classes it declares, as `raysWorker()`
 * writes its entrypoint: `virtual:rays/worker?objects=ChatRoom`, or
 * `virtual:rays/worker/app/admin?objects=ChatRoom`.
 */
declare module "virtual:rays/worker?*" {
  const worker: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  export default worker;
}
