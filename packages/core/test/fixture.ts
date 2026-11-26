// A copy of test/fixtures/app, a small rays Worker, for each test. The
// fixture is compiled once, with its dependencies, by global-setup.ts, so
// each test only recompiles what it changes.

import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, inject } from "vitest";

export interface Fixture {
  /** The copy for the current test. */
  readonly root: string;
  /** Write a file in the copy, relative to its root, making its directory. */
  write(file: string, contents: string): Promise<void>;
}

/** Give each test in the file its own copy of the fixture. */
export function useFixture(): Fixture {
  let root: string | undefined;

  beforeEach(async () => {
    // The real path: on macOS the temporary directory is behind a symlink
    // (/var is /private/var), and Vite resolves imports through it, so a
    // module imported by the other path would load a second time.
    root = await realpath(await mkdtemp(path.join(tmpdir(), "rays-test-")));
    await cp(inject("fixtureTemplate"), root, { recursive: true });
  });

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  return {
    get root() {
      if (root === undefined) throw new Error("No fixture outside a test");
      return root;
    },
    async write(file, contents) {
      const target = path.join(this.root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    },
  };
}

/** A `pub fn main()` returning `type`, with `body`. */
export const mainReturning = (type: string, body: string) =>
  `import rays/worker\n\npub fn main() -> ${type} {\n  ${body}\n}\n`;

/** A Worker's `fetch`, called the way the Workers runtime calls it. */
export function fetcher(worker: unknown) {
  const { fetch } = worker as {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return (path: string) =>
    fetch(new Request(`https://example.com${path}`), {}, ctx);
}
