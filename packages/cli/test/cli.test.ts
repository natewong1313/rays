// Tests the `rays` command against a real Gleam compiler. Each test runs it in
// a copy of test/fixtures/app, a small rays Worker. The build itself is
// tested in @rays/cloudflare; these test the command around it.

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@rays/cloudflare/build";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const repository = path.resolve(here, "..", "..", "..");

// The fixture, compiled once with its dependencies, so each test only
// recompiles what it changes.
let template: string;
let root: string;

beforeAll(async () => {
  template = await mkdtemp(path.join(tmpdir(), "rays-cli-template-"));
  await cp(path.join(here, "fixtures", "app"), template, { recursive: true });
  const toml = await readFile(path.join(template, "gleam.toml"), "utf8");
  await writeFile(
    path.join(template, "gleam.toml"),
    toml.replace(/path = ".*"/, `path = ${JSON.stringify(repository)}`),
  );
  await compile({ root: template });
});

afterAll(async () => {
  await rm(template, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rays-cli-"));
  await cp(template, root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const rays = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });

describe("rays build", () => {
  it("reports the entries it writes", async () => {
    const result = rays("build");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `rays build: wrote ${path.join(".rays", "app.entry.ts")}`,
    );
    await expect(
      readFile(path.join(root, ".rays", "app.entry.ts"), "utf8"),
    ).resolves.toContain('from "../build/dev/javascript/app/app.mjs"');
  });

  it("says nothing about entries that didn't change", () => {
    rays("build");
    const result = rays("build");
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("rays build: wrote");
  });

  it("passes Gleam's errors through and exits non-zero", async () => {
    await writeFile(path.join(root, "src", "app.gleam"), "pub fn main( {\n");
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

  it("rejects unknown options", () => {
    const result = rays("build", "--nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: rays build");
  });
});

describe("rays", () => {
  it("shows help", () => {
    const result = rays("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: rays <command>");
  });

  it("rejects unknown commands", () => {
    const result = rays("nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rays: unknown command "nope".');
  });
});
