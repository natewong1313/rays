// Tests the `rays()` Vite plugin with Vite's own dev server and build, without
// Cloudflare's plugins: Vite loads the Worker in Node.js.

import path from "node:path";
import {
  build,
  createLogger,
  createServer,
  type InlineConfig,
  type Rolldown,
  type ViteDevServer,
} from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { rays, type RaysOptions } from "./vite.ts";
import { fetcher, useFixture } from "../test/fixture.ts";

const fixture = useFixture();

const adminModule = `import app
import rays/worker

pub fn main() -> worker.Worker {
  app.main()
}
`;

const helloAgain = `import gleam/javascript/promise
import rays/worker

pub fn main() -> worker.Worker {
  worker.new(fn(_, _, _) {
    worker.ok()
    |> worker.string_body("Hello again")
    |> promise.resolve
  })
}
`;

function config(options?: RaysOptions): {
  config: InlineConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const logger = createLogger("silent");
  logger.error = (message) => void errors.push(message);
  return {
    errors,
    config: {
      root: fixture.root,
      configFile: false,
      customLogger: logger,
      plugins: [rays(options)],
    },
  };
}

describe("in development", () => {
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(options?: RaysOptions) {
    const { config: inline, errors } = config(options);
    server = await createServer({
      ...inline,
      appType: "custom",
      server: { middlewareMode: true, ws: false },
    });
    const running = server;
    const load = async (id: string) =>
      fetcher((await running.ssrLoadModule(id))["default"]);
    return { server: running, errors, load };
  }

  it("serves the Worker from the module named after the package", async () => {
    const { load } = await start();
    const response = await (await load("virtual:rays/worker"))("/");
    expect(await response.text()).toBe("Hello from app");
  });

  it("serves the Worker from a named module", async () => {
    await fixture.write("src/admin.gleam", adminModule);
    const { load } = await start();
    const response = await (await load("virtual:rays/worker/admin"))("/");
    expect(await response.text()).toBe("Hello from app");
  });

  it("serves the module given as an option", async () => {
    await fixture.write("src/admin.gleam", adminModule);
    const { server } = await start({ module: "admin" });
    const { code } = (await server.transformRequest("virtual:rays/worker", {
      ssr: true,
    }))!;
    expect(code).toContain("src/admin.gleam");
  });

  describe("Durable Object classes", () => {
    const room =
      "import gleam/javascript/promise.{type Promise}\nimport rays/durable_object\n\npub fn room() -> durable_object.DurableObject(Int) {\n  durable_object.new(0)\n  |> durable_object.bind(count)\n}\n\npub fn count(params: durable_object.Params(Nil, Int)) -> Promise(Int) {\n  promise.resolve(durable_object.read_memory(params.memory))\n}\n";
    const lobby =
      "import rays/durable_object\n\npub fn lobby() -> durable_object.DurableObject(Nil) {\n  durable_object.new(Nil)\n}\n";

    // Loaded but not imported: Node.js has no cloudflare:workers.
    async function source(server: ViteDevServer, id: string) {
      const loaded = await server.pluginContainer.load(`\0${id}`);
      return typeof loaded === "string" ? loaded : loaded?.code;
    }

    it("exports every class without a list", async () => {
      await fixture.write("src/app/room.gleam", room);
      await fixture.write("src/app/lobby.gleam", lobby);
      const { server } = await start();
      const code = await source(server, "virtual:rays/worker");
      expect(code).toContain("export { $rays_class_Room as Room };");
      expect(code).toContain("export { $rays_class_Lobby as Lobby };");
      expect(code).toContain("  count(call) {");
    });

    it("exports only the classes it lists", async () => {
      await fixture.write("src/app/room.gleam", room);
      await fixture.write("src/app/lobby.gleam", lobby);
      const { server } = await start();
      const code = await source(server, "virtual:rays/worker?objects=Room");
      expect(code).toContain("export { $rays_class_Room as Room };");
      expect(code).not.toContain("Lobby");

      const none = await source(server, "virtual:rays/worker/app?objects=");
      expect(none).not.toContain("$rays_class_");
    });

    it("refuses a listed class that isn't in the project", async () => {
      await fixture.write("src/app/room.gleam", room);
      const { server } = await start();
      await expect(
        source(server, "virtual:rays/worker?objects=ChatRoom"),
      ).rejects.toThrow(
        "The Worker's exports declare the Durable Object class ChatRoom, but there is no pub fn chat_room()",
      );
    });
  });

  it("accepts the path Cloudflare's Vitest plugin asks for", async () => {
    const { load } = await start();
    const fetch = await load(path.join(fixture.root, "virtual:rays/worker"));
    expect(await (await fetch("/")).text()).toBe("Hello from app");
  });

  it("explains a module that can't be a Worker", async () => {
    await fixture.write("src/helpers.gleam", "pub fn greet() {\n  Nil\n}\n");
    const { load } = await start();
    await expect(load("virtual:rays/worker/helpers")).rejects.toThrow(
      "src/helpers.gleam has no public main function.",
    );
  });

  it("keeps the last good build until a change compiles", async () => {
    const { errors, load } = await start();
    await load("virtual:rays/worker");

    await fixture.write("src/app.gleam", "pub fn main( {\n");
    await until(() => errors.some((error) => error.includes("[rays]")));
    expect(errors.join("\n")).toContain("[rays] gleam build failed.");
    const stale = await load("virtual:rays/worker");
    expect(await (await stale("/")).text()).toBe("Hello from app");

    await fixture.write("src/app.gleam", helloAgain);
    await until(async () => {
      const fresh = await load("virtual:rays/worker");
      return (await (await fresh("/")).text()) === "Hello again";
    });
  });
});

describe("vite build", () => {
  const ssrBuild = (inline: InlineConfig) =>
    build({
      ...inline,
      logLevel: "silent",
      build: { ssr: "virtual:rays/worker", write: false },
    }) as Promise<Rolldown.RolldownOutput[] | Rolldown.RolldownOutput>;

  it("bundles the Worker", async () => {
    const output = await ssrBuild(config().config);
    const [result] = Array.isArray(output) ? output : [output];
    const code = result!.output.map((chunk) =>
      chunk.type === "chunk" ? chunk.code : "",
    );
    expect(code.join("\n")).toContain("Hello from app");
  });

  it("fails when Gleam fails to compile", async () => {
    await fixture.write("src/app.gleam", "pub fn main( {\n");
    await expect(ssrBuild(config().config)).rejects.toThrow(
      "gleam build failed.",
    );
  });
});

// Wait for a condition that a file watcher makes true.
async function until(
  condition: () => boolean | Promise<boolean>,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
