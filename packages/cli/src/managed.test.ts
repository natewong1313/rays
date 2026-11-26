// Tests reading [tools.rays] from gleam.toml and writing Wrangler
// configuration from it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fc, it } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  defaultWorkerName,
  readGleamToml,
  wranglerConfig,
  writeWranglerConfigs,
  type ManagedProject,
} from "./managed.ts";

const letter = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz");
const letterDigitOrUnderscore = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789_",
);
const segment = fc
  .tuple(letter, fc.string({ unit: letterDigitOrUnderscore }))
  .map(([first, rest]) => first + rest);

/** A Gleam package name, such as "my_app". */
const packageName = segment;

/** A Gleam module name, such as "my_app" or "my_app/admin_api". */
const moduleName = fc
  .array(segment, { minLength: 1 })
  .map((segments) => segments.join("/"));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rays-managed-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(tools: string): Promise<ManagedProject> {
  await writeFile(
    path.join(root, "gleam.toml"),
    `name = "app"\nversion = "1.0.0"\n\n${tools}`,
  );
  const { project } = await readGleamToml(root);
  if (project === undefined) throw new Error("No [tools.rays]");
  return project;
}

async function failure(tools: string): Promise<string> {
  try {
    await project(tools);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected an error");
}

const config = (p: ManagedProject, index = 0) =>
  wranglerConfig(p, p.workers[index]!, '"rays"');

describe("reading gleam.toml", () => {
  it("finds no managed project without [tools.rays]", async () => {
    await writeFile(path.join(root, "gleam.toml"), 'name = "app"\n');
    expect(await readGleamToml(root)).toEqual({
      packageName: "app",
      project: undefined,
    });
  });

  it("explains a missing gleam.toml", async () => {
    await expect(readGleamToml(root)).rejects.toThrow("No gleam.toml in");
  });

  it("explains invalid TOML", async () => {
    await writeFile(path.join(root, "gleam.toml"), "name = \n");
    await expect(readGleamToml(root)).rejects.toThrow(
      "gleam.toml is not valid TOML",
    );
  });

  it("refuses unknown settings in [tools.rays]", async () => {
    expect(await failure("[tools.rays]\nvars = 1\n")).toContain(
      '[tools.rays] in gleam.toml has an unknown setting "vars".',
    );
  });

  it("refuses main and build, which rays sets", async () => {
    expect(
      await failure('[tools.rays.wrangler]\nmain = "src/index.ts"\n'),
    ).toContain("[tools.rays.wrangler] sets main, which rays sets itself.");
    expect(
      await failure(
        '[tools.rays.wrangler.env.staging.build]\ncommand = "make"\n',
      ),
    ).toContain("sets build");
  });

  it("refuses to share the project with another Wrangler configuration", async () => {
    await writeFile(path.join(root, "wrangler.toml"), "");
    expect(await failure("[tools.rays.wrangler]\n")).toContain(
      "but there is also a wrangler.toml.",
    );
  });
});

describe("one Worker", () => {
  it("builds the module named after the package", async () => {
    const p = await project(
      '[tools.rays.wrangler]\ncompatibility_date = "2026-09-01"\n',
    );
    expect(p.workers).toEqual([
      {
        module: "app",
        configPath: path.join(root, ".rays", "wrangler.jsonc"),
        wrangler: { name: "app", compatibility_date: "2026-09-01" },
      },
    ]);
    expect(config(p)).toEqual({
      name: "app",
      compatibility_date: "2026-09-01",
      main: "./app.entry.ts",
      build: {
        command: '"rays" build --module app',
        cwd: root,
        watch_dir: "../src",
      },
    });
  });

  it("builds the module it is given", async () => {
    const p = await project(
      '[tools.rays]\nmodule = "app/web"\n\n[tools.rays.wrangler]\ncompatibility_date = "2026-09-01"\n',
    );
    expect(p.workers[0]!.module).toBe("app/web");
    expect(config(p)["main"]).toBe("./app/web.entry.ts");
    expect(p.workers[0]!.wrangler["name"]).toBe("app-web");
  });

  it("passes Wrangler's settings through, with TOML dates as strings", async () => {
    const p = await project(`[tools.rays.wrangler]
name = "my-worker"
compatibility_date = 2026-09-01
compatibility_flags = ["nodejs_compat"]

[tools.rays.wrangler.vars]
GREETING = "Hello"

[[tools.rays.wrangler.kv_namespaces]]
binding = "CACHE"
id = "abc"

[tools.rays.wrangler.env.staging.vars]
GREETING = "Hi"
`);
    expect(JSON.parse(JSON.stringify(config(p)))).toMatchObject({
      name: "my-worker",
      compatibility_date: "2026-09-01",
      compatibility_flags: ["nodejs_compat"],
      vars: { GREETING: "Hello" },
      kv_namespaces: [{ binding: "CACHE", id: "abc" }],
      env: { staging: { vars: { GREETING: "Hi" } } },
    });
  });

  it("makes paths relative to the configuration file", async () => {
    const p = await project(`[tools.rays.wrangler]
compatibility_date = "2026-09-01"
assets = { directory = "./public" }
tsconfig = "/abs/tsconfig.json"
d1_databases = [{ binding = "DB", database_name = "db", migrations_dir = "migrations" }]
containers = [{ class_name = "A", image = "./Dockerfile" }, { class_name = "B", image = "registry.example.com/b:1" }]

[tools.rays.wrangler.env.staging]
assets = { directory = "dist" }
`);
    const result = config(p);
    expect(result["assets"]).toEqual({ directory: "../public" });
    expect(result["tsconfig"]).toBe("/abs/tsconfig.json");
    expect(result["d1_databases"]).toEqual([
      { binding: "DB", database_name: "db", migrations_dir: "../migrations" },
    ]);
    expect(result["containers"]).toEqual([
      { class_name: "A", image: "../Dockerfile" },
      { class_name: "B", image: "registry.example.com/b:1" },
    ]);
    expect(result["env"]).toEqual({
      staging: { assets: { directory: "../dist" } },
    });
    // The settings themselves are left as they were.
    expect(p.workers[0]!.wrangler["assets"]).toEqual({
      directory: "./public",
    });
  });

  it("asks for a compatibility date", async () => {
    const p = await project("[tools.rays.wrangler]\n");
    expect(() => config(p)).toThrow(
      "The app Worker has no compatibility_date. Add one to [tools.rays.wrangler] in gleam.toml",
    );
  });

  it("refuses a module name that isn't one", async () => {
    expect(await failure('[tools.rays]\nmodule = "App"\n')).toContain(
      "module in [tools.rays] must be a Gleam module name",
    );
  });
});

describe("several Workers", () => {
  const shared = `[tools.rays.wrangler]
compatibility_date = "2026-09-01"
vars = { GREETING = "Hello", SHARED = "yes" }
routes = ["example.com/*"]
`;

  it("puts the first listed Worker first", async () => {
    const p = await project(`${shared}
[tools.rays.workers.app]
[tools.rays.workers."app/admin"]
`);
    expect(p.workers.map((w) => w.module)).toEqual(["app", "app/admin"]);
    expect(p.workers.map((w) => w.configPath)).toEqual([
      path.join(root, ".rays", "app.wrangler.jsonc"),
      path.join(root, ".rays", "app", "admin.wrangler.jsonc"),
    ]);
    expect(p.workers.map((w) => w.wrangler["name"])).toEqual([
      "app",
      "app-admin",
    ]);
  });

  it("puts the primary Worker first", async () => {
    const p = await project(`${shared}
[tools.rays.workers."app/admin"]
[tools.rays.workers.app]
primary = true
`);
    expect(p.workers.map((w) => w.module)).toEqual(["app", "app/admin"]);
  });

  it("merges each Worker's settings over the shared ones", async () => {
    const p = await project(`${shared}
[tools.rays.workers.app]
[tools.rays.workers."app/admin".wrangler]
name = "admin"
vars = { GREETING = "Hi" }
routes = ["admin.example.com/*"]
`);
    const admin = config(p, 1);
    expect(admin).toMatchObject({
      name: "admin",
      vars: { GREETING: "Hi", SHARED: "yes" },
      routes: ["admin.example.com/*"],
      main: "./admin.entry.ts",
      build: { watch_dir: "../../src" },
    });
    expect(config(p, 0)["vars"]).toEqual({ GREETING: "Hello", SHARED: "yes" });
  });

  it("allows one primary Worker", async () => {
    expect(
      await failure(`[tools.rays.workers.app]
primary = true
[tools.rays.workers.other]
primary = true
`),
    ).toContain(
      'Only one Worker can be primary, but "app" and "other" both are.',
    );
  });

  it("refuses module and workers together", async () => {
    expect(
      await failure(`[tools.rays]
module = "app"
[tools.rays.workers.app]
`),
    ).toContain("can't have both module and workers");
  });

  it("refuses names that aren't modules, and unknown settings", async () => {
    expect(await failure('[tools.rays.workers."App.gleam"]\n')).toContain(
      '"App.gleam" is not a Gleam module name.',
    );
    expect(await failure("[tools.rays.workers.app]\nvars = 1\n")).toContain(
      '[tools.rays.workers.app] in gleam.toml has an unknown setting "vars".',
    );
  });
});

describe("writing configuration", () => {
  it("writes each Worker's configuration, and only when it changes", async () => {
    const p = await project(`[tools.rays.wrangler]
compatibility_date = "2026-09-01"
[tools.rays.workers.app]
[tools.rays.workers."app/admin"]
`);
    expect(await writeWranglerConfigs(p, '"rays"')).toBe(true);
    const written = await readFile(
      path.join(root, ".rays", "app", "admin.wrangler.jsonc"),
      "utf8",
    );
    expect(written).toMatch(/^\/\/ Generated by rays/);
    expect(JSON.parse(written.replace(/^\/\/.*\n/gm, ""))).toMatchObject({
      name: "app-admin",
      main: "./admin.entry.ts",
    });
    expect(await readFile(path.join(root, ".rays", ".gitignore"), "utf8")).toBe(
      "*\n",
    );
    expect(await writeWranglerConfigs(p, '"rays"')).toBe(false);
  });

  it("removes the configuration of Workers no longer listed", async () => {
    await mkdir(path.join(root, ".rays"));
    await writeFile(path.join(root, ".rays", "old.wrangler.jsonc"), "{}");
    await writeFile(path.join(root, ".rays", "app.entry.ts"), "");
    const p = await project(
      '[tools.rays.wrangler]\ncompatibility_date = "2026-09-01"\n',
    );
    expect(await writeWranglerConfigs(p, '"rays"')).toBe(true);
    expect(existsSync(path.join(root, ".rays", "old.wrangler.jsonc"))).toBe(
      false,
    );
    expect(existsSync(path.join(root, ".rays", "app.entry.ts"))).toBe(true);
    expect(existsSync(path.join(root, ".rays", "wrangler.jsonc"))).toBe(true);
  });

  it("writes nothing if any Worker's configuration is invalid", async () => {
    const p = await project(`[tools.rays.workers.app.wrangler]
compatibility_date = "2026-09-01"
[tools.rays.workers.other]
`);
    await expect(writeWranglerConfigs(p, '"rays"')).rejects.toThrow(
      "The other Worker has no compatibility_date.",
    );
    expect(existsSync(path.join(root, ".rays"))).toBe(false);
  });
});

describe("defaultWorkerName", () => {
  it("names Workers after the package and module, with dashes", () => {
    expect(defaultWorkerName("my_app", "my_app")).toBe("my-app");
    expect(defaultWorkerName("my_app", "my_app/admin_api")).toBe(
      "my-app-admin-api",
    );
    expect(defaultWorkerName("my_app", "jobs")).toBe("my-app-jobs");
  });

  it.prop([packageName, moduleName])(
    "always gives lowercase letters, digits and dashes",
    (packageName, module) => {
      expect(defaultWorkerName(packageName, module)).toMatch(
        /^[a-z][a-z0-9-]*$/,
      );
    },
  );

  it.prop([packageName, moduleName])(
    "starts with the package's name",
    (packageName, module) => {
      expect(defaultWorkerName(packageName, module)).toMatch(
        new RegExp(`^${dashed(packageName)}(-|$)`),
      );
    },
  );

  it.prop([packageName, moduleName])(
    "names a module the same with or without the package's prefix",
    (packageName, module) => {
      fc.pre(module !== packageName);
      expect(defaultWorkerName(packageName, `${packageName}/${module}`)).toBe(
        defaultWorkerName(packageName, module),
      );
    },
  );
});

/** `name` with dashes for underscores, as Worker names have them. */
function dashed(name: string): string {
  return name.replaceAll("_", "-");
}
