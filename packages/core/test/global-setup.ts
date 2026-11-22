// Compiles test/fixtures/app once, with its dependencies, before any test
// file runs. Each test then copies the compiled project (see fixture.ts), so
// it only recompiles what it changes, and a test run resolves and downloads
// the fixture's dependencies once rather than once per file.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { compile } from "../src/build.ts";

declare module "vitest" {
  interface ProvidedContext {
    /** The compiled copy of the fixture that each test copies. */
    fixtureTemplate: string;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "app");
const repository = path.resolve(here, "..", "..", "..");

export default async function setup(project: TestProject) {
  const template = await mkdtemp(path.join(tmpdir(), "rays-template-"));
  await cp(fixture, template, { recursive: true });
  const toml = await readFile(path.join(template, "gleam.toml"), "utf8");
  await writeFile(
    path.join(template, "gleam.toml"),
    toml.replace(/path = ".*"/, `path = ${JSON.stringify(repository)}`),
  );
  await compile({ root: template });
  project.provide("fixtureTemplate", template);

  return async () => {
    await rm(template, { recursive: true, force: true });
  };
}
