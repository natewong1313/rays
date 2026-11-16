// A copy of test/fixtures/app, a small rays Worker, for each test. The
// fixture is compiled once with its dependencies, so each test only
// recompiles what it changes.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { compile } from "../src/build.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "app");
const repository = path.resolve(here, "..", "..", "..");

export interface Fixture {
  /** The copy for the current test. */
  readonly root: string;
  /** Write a file in the copy, relative to its root. */
  write(file: string, contents: string): Promise<void>;
}

/** Give each test in the file its own copy of the fixture. */
export function useFixture(): Fixture {
  let template: string;
  let root: string | undefined;

  beforeAll(async () => {
    template = await mkdtemp(path.join(tmpdir(), "rays-template-"));
    await cp(fixture, template, { recursive: true });
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
    root = await mkdtemp(path.join(tmpdir(), "rays-test-"));
    await cp(template, root, { recursive: true });
  });

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  return {
    get root() {
      if (root === undefined) throw new Error("No fixture outside a test");
      return root;
    },
    write(file, contents) {
      return writeFile(path.join(this.root, file), contents);
    },
  };
}

/** A `pub fn main()` returning `type`, with `body`. */
export const mainReturning = (type: string, body: string) =>
  `import rays/workers\n\npub fn main() -> ${type} {\n  ${body}\n}\n`;

/** A Worker's `fetch`, called the way the Workers runtime calls it. */
export function fetcher(worker: unknown) {
  const { fetch } = worker as {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return (path: string) =>
    fetch(new Request(`https://example.com${path}`), {}, ctx);
}
