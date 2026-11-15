// Tests `build`, which `rays build` runs, against a real Gleam compiler.

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { build, BuildError } from "../src/build.ts";
import { fetcher, mainReturning, useFixture } from "./fixture.ts";

const fixture = useFixture();
const write = (file: string, contents: string) => fixture.write(file, contents);

async function importWorker(entry: string) {
  // A query string, so each import evaluates the module afresh.
  const url = `${pathToFileURL(entry).href}?t=${Date.now()}`;
  const module = await import(/* @vite-ignore */ url);
  return fetcher(module.default);
}

describe("build", () => {
  it("writes an entry for the module named after the package", async () => {
    const [entry, ...rest] = await build({ root: fixture.root });
    expect(rest).toEqual([]);
    expect(entry).toEqual({
      module: "app",
      path: path.join(fixture.root, ".rays", "app.entry.ts"),
      changed: true,
    });

    const fetch = await importWorker(entry!.path);
    const response = await fetch("/");
    expect(await response.text()).toBe("Hello from app");
  });

  it("ignores everything it writes in git", async () => {
    await build({ root: fixture.root });
    expect(
      await readFile(path.join(fixture.root, ".rays", ".gitignore"), "utf8"),
    ).toBe("*\n");
  });

  it("leaves an unchanged entry alone", async () => {
    await build({ root: fixture.root });
    const [entry] = await build({ root: fixture.root });
    expect(entry!.changed).toBe(false);
  });

  it("builds the modules it is given, including nested ones", async () => {
    await write(
      "src/admin.gleam",
      "import app\nimport rays/workers\n\npub fn main() -> workers.Worker {\n  app.main()\n}\n",
    );
    await mkdir(path.join(fixture.root, "src", "api"));
    await write(
      "src/api/worker.gleam",
      "import app\nimport rays/workers\n\npub fn main() -> workers.Worker {\n  app.main()\n}\n",
    );

    const entries = await build({
      root: fixture.root,
      modules: ["admin", "api/worker"],
    });
    expect(
      entries.map((entry) => path.relative(fixture.root, entry.path)),
    ).toEqual([
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
    await rm(path.join(fixture.root, "gleam.toml"));
    await expect(build({ root: fixture.root })).rejects.toThrow(
      /No gleam.toml in/,
    );
  });

  it("rejects a name that isn't a Gleam module", async () => {
    await expect(
      build({ root: fixture.root, modules: ["App.gleam"] }),
    ).rejects.toThrow('"App.gleam" is not a Gleam module name.');
  });

  it("fails when Gleam can't be found", async () => {
    await expect(
      build({
        root: fixture.root,
        gleam: path.join(fixture.root, "no-such-gleam"),
      }),
    ).rejects.toThrow(
      /Could not find Gleam at .*no-such-gleam.*RAYS_GLEAM_BIN/,
    );
  });

  it("fails for a module that doesn't exist", async () => {
    await expect(
      build({ root: fixture.root, modules: ["missing"] }),
    ).rejects.toThrow(
      /There is no Gleam module "missing": .*src\/missing.gleam does not exist\./,
    );
  });

  it("fails for a module without a main function", async () => {
    await write("src/helpers.gleam", "pub fn greet() {\n  Nil\n}\n");
    await expect(
      build({ root: fixture.root, modules: ["helpers"] }),
    ).rejects.toThrow("src/helpers.gleam has no public main function.");
  });

  it("fails for a main function that takes arguments", async () => {
    await write("src/args.gleam", "pub fn main(name: String) {\n  name\n}\n");
    await expect(
      build({ root: fixture.root, modules: ["args"] }),
    ).rejects.toThrow("main in src/args.gleam must take no arguments.");
  });

  it("keeps the last good entry when Gleam fails to compile", async () => {
    const [entry] = await build({ root: fixture.root });
    const good = await readFile(entry!.path, "utf8");

    await write("src/app.gleam", "pub fn main( {\n");
    const failure = build({ root: fixture.root });
    await expect(failure).rejects.toBeInstanceOf(BuildError);
    await expect(failure).rejects.toThrow("gleam build failed.");
    expect(await readFile(entry!.path, "utf8")).toBe(good);
  });

  it("writes no entry if any module fails", async () => {
    await expect(
      build({ root: fixture.root, modules: ["app", "missing"] }),
    ).rejects.toThrow(BuildError);
    await expect(
      readFile(path.join(fixture.root, ".rays", "app.entry.ts")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("fails for a main function that doesn't return a Worker", async () => {
    await write("src/plain.gleam", 'pub fn main() {\n  "not a worker"\n}\n');
    await expect(
      build({ root: fixture.root, modules: ["plain"] }),
    ).rejects.toThrow(
      "main in src/plain.gleam must return a workers.Worker, but it returns String.",
    );
  });

  it("names the type a main function returns", async () => {
    await write("src/env.gleam", mainReturning("workers.Env", "panic"));
    await expect(
      build({ root: fixture.root, modules: ["env"] }),
    ).rejects.toThrow("but it returns rays/workers.Env.");
    await write(
      "src/handler.gleam",
      mainReturning("workers.Handler", "fn(_, _, _) { panic }"),
    );
    await expect(
      build({ root: fixture.root, modules: ["handler"] }),
    ).rejects.toThrow("but it returns a function.");
  });

  it("writes an entry that rejects a value that only claims to be a Worker", async () => {
    await write(
      "src/fake.gleam",
      'import rays/workers\n\n@external(javascript, "./fake_ffi.mjs", "fake")\npub fn main() -> workers.Worker\n',
    );
    await write("src/fake_ffi.mjs", "export const fake = () => ({});\n");
    const [entry] = await build({ root: fixture.root, modules: ["fake"] });
    await expect(importWorker(entry!.path)).rejects.toThrow(
      "main in src/fake.gleam must return a rays Worker, made with workers.new.",
    );
  });
});
