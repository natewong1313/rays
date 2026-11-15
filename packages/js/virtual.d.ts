// Types for the modules made by the `rays()` Vite plugin from
// `@rays/cloudflare/vite`. Add them to a project with
// `"types": ["@rays/cloudflare/virtual"]` in tsconfig.json, or
// `/// <reference types="@rays/cloudflare/virtual" />`.
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
