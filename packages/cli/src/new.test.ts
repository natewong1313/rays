// Tests `rays new`, and that the project it makes builds, tests and deploys
// (as a dry run) with the real Gleam and Wrangler.

import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "cli.ts");
const repository = path.resolve(here, "..", "..", "..");

// Inside this package, so the projects find its Wrangler in node_modules.
// Not in node_modules itself, where Node.js won't run rays' TypeScript FFI.
const scratch = path.join(here, "..", ".test-projects");

let parent: string;

beforeEach(async () => {
  await mkdir(scratch, { recursive: true });
  parent = await mkdtemp(path.join(scratch, "rays-new-"));
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

function run(command: string, args: string[], cwd = parent) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

const rays = (args: string[], cwd = parent) =>
  run(process.execPath, [cli, ...args], cwd);

const create = (name: string) =>
  rays(["new", name, "--no-install", "--rays-path", repository]);

describe("rays new", () => {
  it("creates a project named after its directory", async () => {
    const result = create("my-app");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created my_app in my-app.");

    const root = path.join(parent, "my-app");
    expect((await readdir(root, { recursive: true })).sort()).toEqual([
      ".gitignore",
      "gleam.toml",
      "package.json",
      "src",
      path.join("src", "my_app.gleam"),
      "test",
      path.join("test", "my_app_test.gleam"),
    ]);
    const toml = await readFile(path.join(root, "gleam.toml"), "utf8");
    expect(toml).toContain('name = "my_app"');
    expect(toml).toContain(
      `rays = { path = ${JSON.stringify(path.relative(root, repository))} }`,
    );
    expect(toml).toMatch(/compatibility_date = "\d{4}-\d\d-\d\d"/);
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    expect(pkg).toMatchObject({
      name: "my-app",
      devDependencies: { wrangler: expect.any(String) },
    });
  });

  it("depends on rays from Hex by default", async () => {
    rays(["new", "app", "--no-install"]);
    const toml = await readFile(path.join(parent, "app", "gleam.toml"), "utf8");
    expect(toml).toContain('rays = ">= 1.0.0 and < 2.0.0"');
  });

  it("refuses a directory that isn't empty", async () => {
    await mkdir(path.join(parent, "app"));
    await writeFile(path.join(parent, "app", "notes.txt"), "");
    const result = create("app");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists and isn't empty.");
  });

  it("refuses a name that can't be a Gleam package", () => {
    for (const name of ["1app", "my.app", "type"]) {
      const result = create(name);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("can't be a Gleam package name.");
    }
  });

  it("makes a project that tests, builds and deploys", async () => {
    expect(create("hello").status).toBe(0);
    const root = path.join(parent, "hello");

    const test = run("gleam", ["test"], root);
    expect(test.stdout + test.stderr).toContain("1 passed, no failures");

    const build = rays(["build"], root);
    expect(build.status).toBe(0);
    expect(build.stderr).toContain(
      "rays build: wrote the Wrangler configuration in .rays/",
    );
    expect(build.stderr).toContain(
      `rays build: wrote ${path.join(".rays", "hello.entry.ts")}`,
    );

    const deploy = rays(
      ["deploy", "--dry-run", "--outdir", path.join(root, "out")],
      root,
    );
    expect(deploy.stderr + deploy.stdout).toContain("--dry-run: exiting now.");
    expect(deploy.status).toBe(0);
    expect(
      await readFile(path.join(root, "out", "hello.entry.js"), "utf8"),
    ).toContain("GREETING");
  });
});
