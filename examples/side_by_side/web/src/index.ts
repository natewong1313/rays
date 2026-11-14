// The TypeScript Worker. It serves the site itself and sends everything
// under `/api/` to the Gleam Worker through the `API` service binding. The
// Gleam Worker calls back to `/whoami` here through its `WEB` binding.

interface Env {
  API: Fetcher;
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return env.API.fetch(request);
    if (pathname === "/whoami") return new Response("Joe");
    if (pathname === "/") {
      return new Response("Hello from TypeScript! Try /api/greeting.");
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
