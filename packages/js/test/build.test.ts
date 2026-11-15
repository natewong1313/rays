// Tests `rays build` against a real Gleam compiler. Each test builds a copy of
// test/fixtures/app, a small rays Worker, in a temporary directory.

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { build, BuildError } from "../src/project.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "app");
const cli = path.join(here, "..", "src", "cli.ts");
const repository = path.resolve(here, "..", "..", "..");

// The fixture, compiled once with its dependencies, so each test only
// recompiles what it changes.
let template: string;
let root: string;

beforeAll(async () => {
  template = await mkdtemp(path.join(tmpdir(), "rays-template-"));
  await cp(fixture, template, { recursive: true });
  const toml = await readFile(path.join(template, "gleam.toml"), "utf8");
  await writeFile(
    path.join(template, "gleam.toml"),
    toml.replace(/path = ".*"/, `path = ${JSON.stringify(repository)}`),
  );
  await build({ root: template });
  await rm(path.join(template, ".rays"), { recursive: true });
});

afterAll(async () => {
  await rm(template, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rays-build-"));
  await cp(template, root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = (file: string, contents: string) =>
  writeFile(path.join(root, file), contents);

async function importWorker(entry: string) {
  // A query string, so each import evaluates the module afresh.
  const url = `${pathToFileURL(entry).href}?t=${Date.now()}`;
  const module = await import(/* @vite-ignore */ url);
  const worker = module.default as {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  return (path: string) =>
    worker.fetch(new Request(`https://example.com${path}`), {}, ctx);
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

const mainReturning = (type: string, body: string) =>
  `import rays/workers\n\npub fn main() -> ${type} {\n  ${body}\n}\n`;

describe("build", () => {
  it("writes an entry for the module named after the package", async () => {
    const [entry, ...rest] = await build({ root });
    expect(rest).toEqual([]);
    expect(entry).toEqual({
      module: "app",
      path: path.join(root, ".rays", "app.entry.ts"),
      changed: true,
    });

    const fetch = await importWorker(entry!.path);
    const response = await fetch("/");
    expect(await response.text()).toBe("Hello from app");
  });

  it("ignores everything it writes in git", async () => {
    await build({ root });
    expect(await readFile(path.join(root, ".rays", ".gitignore"), "utf8")).toBe(
      "*\n",
    );
  });

  it("leaves an unchanged entry alone", async () => {
    await build({ root });
    const [entry] = await build({ root });
    expect(entry!.changed).toBe(false);
  });

  it("builds the modules it is given, including nested ones", async () => {
    await write(
      "src/admin.gleam",
      "import app\nimport rays/workers\n\npub fn main() -> workers.Worker {\n  app.main()\n}\n",
    );
    await mkdir(path.join(root, "src", "api"));
    await write(
      "src/api/worker.gleam",
      "import app\nimport rays/workers\n\npub fn main() -> workers.Worker {\n  app.main()\n}\n",
    );

    const entries = await build({ root, modules: ["admin", "api/worker"] });
    expect(entries.map((entry) => path.relative(root, entry.path))).toEqual([
      path.join(".rays", "admin.entry.ts"),
      path.join(".rays", "api", "worker.entry.ts"),
    ]);
    for (const entry of entries) {
      const fetch = await importWorker(entry.path);
      const response = await fetch("/");
      expect(await response.text()).toBe("Hello from app");
    }
  });

  it("fails without a gleam.toml", async () => {
    await rm(path.join(root, "gleam.toml"));
    await expect(build({ root })).rejects.toThrow(/No gleam.toml in/);
  });

  it("rejects a name that isn't a Gleam module", async () => {
    await expect(build({ root, modules: ["App.gleam"] })).rejects.toThrow(
      '"App.gleam" is not a Gleam module name.',
    );
  });

  it("fails when Gleam can't be found", async () => {
    await expect(
      build({ root, gleam: path.join(root, "no-such-gleam") }),
    ).rejects.toThrow(
      /Could not find Gleam at .*no-such-gleam.*RAYS_GLEAM_BIN/,
    );
  });

  it("fails for a module that doesn't exist", async () => {
    await expect(build({ root, modules: ["missing"] })).rejects.toThrow(
      /There is no Gleam module "missing": .*src\/missing.gleam does not exist\./,
    );
  });

  it("fails for a module without a main function", async () => {
    await write("src/helpers.gleam", "pub fn greet() {\n  Nil\n}\n");
    await expect(build({ root, modules: ["helpers"] })).rejects.toThrow(
      "src/helpers.gleam has no public main function.",
    );
  });

  it("fails for a main function that takes arguments", async () => {
    await write("src/args.gleam", "pub fn main(name: String) {\n  name\n}\n");
    await expect(build({ root, modules: ["args"] })).rejects.toThrow(
      "main in src/args.gleam must take no arguments.",
    );
  });

  it("keeps the last good entry when Gleam fails to compile", async () => {
    const [entry] = await build({ root });
    const good = await readFile(entry!.path, "utf8");

    await write("src/app.gleam", "pub fn main( {\n");
    const failure = build({ root });
    await expect(failure).rejects.toBeInstanceOf(BuildError);
    await expect(failure).rejects.toThrow("gleam build failed.");
    expect(await readFile(entry!.path, "utf8")).toBe(good);
  });

  it("writes no entry if any module fails", async () => {
    await expect(build({ root, modules: ["app", "missing"] })).rejects.toThrow(
      BuildError,
    );
    await expect(
      readFile(path.join(root, ".rays", "app.entry.ts")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("fails for a main function that doesn't return a Worker", async () => {
    await write("src/plain.gleam", 'pub fn main() {\n  "not a worker"\n}\n');
    await expect(build({ root, modules: ["plain"] })).rejects.toThrow(
      "main in src/plain.gleam must return a workers.Worker, but it returns String.",
    );
  });

  it("names the type a main function returns", async () => {
    await write("src/env.gleam", mainReturning("workers.Env", "panic"));
    await expect(build({ root, modules: ["env"] })).rejects.toThrow(
      "but it returns rays/workers.Env.",
    );
    await write(
      "src/handler.gleam",
      mainReturning("workers.Handler", "fn(_, _, _) { panic }"),
    );
    await expect(build({ root, modules: ["handler"] })).rejects.toThrow(
      "but it returns a function.",
    );
  });

  it("writes an entry that rejects a value that only claims to be a Worker", async () => {
    await write(
      "src/fake.gleam",
      'import rays/workers\n\n@external(javascript, "./fake_ffi.mjs", "fake")\npub fn main() -> workers.Worker\n',
    );
    await write("src/fake_ffi.mjs", "export const fake = () => ({});\n");
    const [entry] = await build({ root, modules: ["fake"] });
    await expect(importWorker(entry!.path)).rejects.toThrow(
      "main in src/fake.gleam must return a rays Worker, made with workers.new.",
    );
  });
});

describe("rays build", () => {
  const rays = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
    });

  it("reports the entries it writes", () => {
    const result = rays("build");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `rays build: wrote ${path.join(".rays", "app.entry.ts")}`,
    );
  });

  it("passes Gleam's errors through and exits non-zero", async () => {
    await write("src/app.gleam", "pub fn main( {\n");
    const result = rays("build");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: Syntax error");
    expect(result.stderr).toContain("rays build: gleam build failed.");
  });

  it("accepts --module", () => {
    const result = rays("build", "--module", "missing");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('There is no Gleam module "missing"');
  });

  it("rejects unknown options and commands", () => {
    expect(rays("build", "--nope").status).toBe(1);
    const unknown = rays("deploy");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('rays: unknown command "deploy".');
  });
});
