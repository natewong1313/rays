// Types the main module as a rays Worker from the `rays()` Vite plugin, for
// a project with a Wrangler config file whose `main` is `virtual:rays/worker`.
// Add it with `"types": ["@rays/config/main"]` in tsconfig.json.
//
// With `cloudflare.config.ts` and `raysWorker()` from `@rays/config/cf`
// it isn't needed: the types `cf` generates already declare the main module.
//
// `wrangler types` normally declares the main module itself, which types
// `exports` from `cloudflare:workers`, but it can't follow a virtual module.
// Leave this out if your main module is a file: `wrangler types` then
// declares it too, and with `skipLibCheck` TypeScript silently keeps one of
// the two declarations instead of reporting the conflict.

/// <reference path="./virtual.d.ts" />

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("virtual:rays/worker");
  }
}
