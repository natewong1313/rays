// Tests `rays dev`, `rays deploy` and `rays wrangler` against a stand-in for
// Wrangler that records how it was run, and the helpers they share.

import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  devVarsFiles,
  hasOption,
  selectedEnvironment,
  withConfigs,
} from "../src/wrangler.ts";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.ts",
);

let root: string;
let log: string;

// Records each run as a line of JSON, and fails when its arguments include
// $STUB_FAIL_ON.
const stub = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  loadDotEnv: process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV,
}) + "\\n");
const failOn = process.env.STUB_FAIL_ON;
process.exit(failOn && args.some((arg) => arg.includes(failOn)) ? 3 : 0);
`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rays-commands-"));
  log = path.join(root, "wrangler.log");
  const bin = path.join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "wrangler"), stub);
  await chmod(path.join(bin, "wrangler"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const gleamToml = (tools: string) =>
  writeFile(
    path.join(root, "gleam.toml"),
    `name = "app"\nversion = "1.0.0"\n\n${tools}`,
  );

const oneWorker = '[tools.rays.wrangler]\ncompatibility_date = "2026-09-01"\n';
const twoWorkers = `${oneWorker}
[tools.rays.workers."app/admin"]
[tools.rays.workers.app]
primary = true
`;

function rays(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ENV: "", ...env, STUB_LOG: log },
  });
}

async function runs(): Promise<
  { args: string[]; cwd: string; loadDotEnv?: string }[]
> {
  try {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe("rays dev", () => {
  it("runs wrangler dev with every Worker's configuration", async () => {
    await gleamToml(twoWorkers);
    const result = rays(["dev", "--port", "9000"]);
    expect(result.status).toBe(0);
    const [run, ...rest] = await runs();
    expect(rest).toEqual([]);
    expect(run!.cwd).toBe(root);
    expect(run!.args).toEqual([
      "dev",
      "--port",
      "9000",
      "--persist-to",
      path.join(".wrangler", "state"),
      "-c",
      path.join(".rays", "app.wrangler.jsonc"),
      "-c",
      path.join(".rays", "app", "admin.wrangler.jsonc"),
    ]);
    expect(result.stderr).toContain(
      "rays dev: wrote the Wrangler configuration in .rays/",
    );
  });

  it("passes the project's local variables", async () => {
    await gleamToml(oneWorker);
    await writeFile(path.join(root, ".dev.vars"), "TOKEN=1\n");
    await writeFile(path.join(root, ".env"), "TOKEN=2\n");
    rays(["dev"], { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" });
    const [run] = await runs();
    expect(run!.args).toContain(path.join(root, ".dev.vars"));
    expect(run!.args).not.toContain(path.join(root, ".env"));
    // Wrangler loads --env-file files as .env files, so they must be on.
    expect(run!.loadDotEnv).toBe("true");
  });

  it("leaves options it would set to the ones given", async () => {
    await gleamToml(oneWorker);
    await writeFile(path.join(root, ".dev.vars"), "TOKEN=1\n");
    await writeFile(path.join(root, "mine.env"), "TOKEN=2\n");
    rays(["dev", "--persist-to=data", "--env-file", "mine.env"]);
    const [run] = await runs();
    expect(run!.args.filter((arg) => arg.startsWith("--persist-to"))).toEqual([
      "--persist-to=data",
    ]);
    expect(run!.args).not.toContain(path.join(root, ".dev.vars"));
  });

  it("exits as Wrangler does", async () => {
    await gleamToml(oneWorker);
    const result = rays(["dev"], { STUB_FAIL_ON: "dev" });
    expect(result.status).toBe(3);
  });

  it("needs [tools.rays]", async () => {
    await gleamToml("");
    const result = rays(["dev"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "rays dev: rays dev runs Wrangler with the settings in [tools.rays] in gleam.toml, and gleam.toml has none.",
    );
    expect(await runs()).toEqual([]);
  });

  it("explains invalid settings without running Wrangler", async () => {
    await gleamToml("[tools.rays.wrangler]\n");
    const result = rays(["dev"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no compatibility_date");
    expect(await runs()).toEqual([]);
  });
});

describe("rays deploy", () => {
  it("deploys every Worker, the primary one last", async () => {
    await gleamToml(twoWorkers);
    const result = rays(["deploy", "--env", "staging"]);
    expect(result.status).toBe(0);
    expect((await runs()).map((run) => run.args)).toEqual([
      [
        "deploy",
        "--env",
        "staging",
        "-c",
        path.join(".rays", "app", "admin.wrangler.jsonc"),
      ],
      [
        "deploy",
        "--env",
        "staging",
        "-c",
        path.join(".rays", "app.wrangler.jsonc"),
      ],
    ]);
  });

  it("stops at the first Worker that fails", async () => {
    await gleamToml(twoWorkers);
    const result = rays(["deploy"], { STUB_FAIL_ON: "admin" });
    expect(result.status).toBe(3);
    expect(await runs()).toHaveLength(1);
  });
});

describe("rays wrangler", () => {
  it("runs the command with the primary Worker's configuration", async () => {
    await gleamToml(twoWorkers);
    rays(["wrangler", "secret", "put", "TOKEN"]);
    const [run] = await runs();
    expect(run!.args).toEqual([
      "secret",
      "put",
      "TOKEN",
      "-c",
      path.join(".rays", "app.wrangler.jsonc"),
    ]);
  });

  it("runs it for the Worker it is given", async () => {
    await gleamToml(twoWorkers);
    rays(["wrangler", "--worker", "app/admin", "tail", "--", "extra"]);
    const [run] = await runs();
    expect(run!.args).toEqual([
      "tail",
      "-c",
      path.join(".rays", "app", "admin.wrangler.jsonc"),
      "--",
      "extra",
    ]);
  });

  it("names the Workers there are", async () => {
    await gleamToml(twoWorkers);
    const result = rays(["wrangler", "--worker", "nope", "tail"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'There is no Worker "nope" in gleam.toml. The Workers are app, app/admin.',
    );
  });

  it("needs a command", async () => {
    await gleamToml(oneWorker);
    const result = rays(["wrangler"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("give a Wrangler command");
  });
});

describe("helpers", () => {
  it("puts configurations before --", () => {
    expect(withConfigs(["a"], ["x", "y"])).toEqual(["a", "-c", "x", "-c", "y"]);
    expect(withConfigs(["a", "--", "b"], ["x"])).toEqual([
      "a",
      "-c",
      "x",
      "--",
      "b",
    ]);
  });

  it("finds options, with or without =", () => {
    expect(hasOption(["--port", "1"], "--port")).toBe(true);
    expect(hasOption(["--port=1"], "--port")).toBe(true);
    expect(hasOption(["--portal"], "--port")).toBe(false);
  });

  it("finds the selected environment", () => {
    expect(selectedEnvironment(["--env", "staging"])).toBe("staging");
    expect(selectedEnvironment(["-e", "staging"])).toBe("staging");
    expect(selectedEnvironment(["--env=staging"])).toBe("staging");
    expect(selectedEnvironment(["--", "--env", "staging"])).toBe(
      process.env["CLOUDFLARE_ENV"] || undefined,
    );
  });

  describe("local variable files, as Wrangler chooses them", () => {
    const files = (names: string[], environment?: string) =>
      Promise.all(
        names.map((name) => writeFile(path.join(root, name), "")),
      ).then(() =>
        devVarsFiles(root, environment).map((file) => path.basename(file)),
      );

    it("uses .dev.vars over .env files", async () => {
      expect(await files([".dev.vars", ".env"])).toEqual([".dev.vars"]);
    });

    it("uses an environment's .dev.vars instead of .dev.vars", async () => {
      expect(
        await files([".dev.vars", ".dev.vars.staging"], "staging"),
      ).toEqual([".dev.vars.staging"]);
      expect(await files([], "production")).toEqual([".dev.vars"]);
    });

    it("merges .env files, most specific last", async () => {
      expect(
        await files(
          [".env", ".env.local", ".env.staging", ".env.staging.local"],
          "staging",
        ),
      ).toEqual([".env", ".env.staging", ".env.local", ".env.staging.local"]);
      expect(await files([])).toEqual([".env", ".env.local"]);
    });
  });
});
