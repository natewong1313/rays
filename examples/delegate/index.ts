// A TypeScript Worker that hands part of its routes to Gleam.
//
// Requests under `/gleam/` go to the rays Worker built by `main` in
// src/routes.gleam, which sees the request unchanged. Everything else is
// handled here.
import { handler } from "@rays/cloudflare/runtime";
import { main } from "./build/dev/javascript/delegate/routes.mjs";

const gleam = handler<Env>(main());

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/gleam/")) return gleam.fetch(request, env, ctx);
    if (pathname === "/") return new Response("Hello from TypeScript!");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
