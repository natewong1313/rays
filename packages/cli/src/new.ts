/**
 * `rays new`: create a project managed by rays.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError, today } from "./managed.ts";
import { exitCode } from "./wrangler.ts";

export interface NewOptions {
  /** The directory to create the project in. */
  directory: string;
  /** Use rays from this local directory instead of Hex. */
  raysPath?: string;
  /** Install the npm dependencies. Defaults to true. */
  install?: boolean;
}

// Gleam's reserved words, which can't name a package's main module.
const KEYWORDS = new Set(
  "as assert auto case const delegate derive echo else fn if implement import let macro opaque panic pub test todo type use".split(
    " ",
  ),
);

/**
 * Create a project: gleam.toml with `[tools.rays]`, a Worker in `src/`, a
 * test, and a package.json that installs Wrangler.
 *
 * @returns The project's package name.
 * @throws {CliError} If the directory isn't empty, or its name can't be a
 *   Gleam package name.
 */
export async function createProject(options: NewOptions): Promise<string> {
  const root = path.resolve(options.directory);
  const name = path.basename(root).toLowerCase().replaceAll("-", "_");
  if (!/^[a-z][a-z0-9_]*$/.test(name) || KEYWORDS.has(name)) {
    throw new CliError(
      `"${path.basename(root)}" can't be a Gleam package name. Use lowercase letters, numbers and underscores or dashes, starting with a letter, such as my_app.`,
    );
  }
  if (existsSync(root) && (await readdir(root)).length > 0) {
    throw new CliError(`${root} already exists and isn't empty.`);
  }

  const rays =
    options.raysPath === undefined
      ? `">= 1.0.0 and < 2.0.0"`
      : `{ path = ${JSON.stringify(
          path.relative(root, path.resolve(options.raysPath)) || ".",
        )} }`;

  const files: Record<string, string> = {
    "gleam.toml": `name = "${name}"
version = "1.0.0"
target = "javascript"

[dependencies]
gleam_stdlib = ">= 1.0.0 and < 2.0.0"
gleam_http = ">= 4.5.0 and < 5.0.0"
gleam_javascript = ">= 1.0.1 and < 2.0.0"
rays = ${rays}

[dev_dependencies]
gleeunit = ">= 1.0.0 and < 2.0.0"

# rays writes the Wrangler configuration from these settings. This table
# takes anything wrangler.toml does, except main and build, which rays sets.
[tools.rays.wrangler]
compatibility_date = "${today()}"

[tools.rays.wrangler.vars]
GREETING = "Hello"
`,
    [`src/${name}.gleam`]: `import gleam/http.{Get}
import gleam/javascript/promise.{type Promise}
import gleam/result
import rays/worker.{type Context, type Env, type Request, type Response}

pub fn main() -> worker.Worker {
  worker.new(handle_request)
}

pub fn handle_request(
  req: Request,
  env: Env,
  _ctx: Context,
) -> Promise(Response) {
  case worker.path_segments(req) {
    [] -> hello(req, env, "world")
    [name] -> hello(req, env, name)
    _ -> promise.resolve(worker.not_found())
  }
}

// GET / and GET /:name, greeting with the GREETING variable from gleam.toml.
fn hello(req: Request, env: Env, name: String) -> Promise(Response) {
  use <- worker.require_method(req, Get)
  let greeting = worker.env_var(env, "GREETING") |> result.unwrap("Hello")
  worker.ok()
  |> worker.string_body(greeting <> ", " <> name <> "!")
  |> promise.resolve
}
`,
    [`test/${name}_test.gleam`]: `import gleam/http
import gleam/javascript/promise
import gleeunit
import ${name}
import rays/worker/simulate

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn hello_test() {
  let env = simulate.env() |> simulate.env_var("GREETING", "Hi")
  let request = simulate.request(http.Get, "/Joe")
  use response <- promise.map(${name}.handle_request(
    request,
    env,
    simulate.context(),
  ))
  assert response.status == 200
  assert simulate.read_body(response) == "Hi, Joe!"
}
`,
    "package.json": `${JSON.stringify(
      {
        name: name.replaceAll("_", "-"),
        private: true,
        type: "module",
        scripts: {
          dev: "rays dev",
          deploy: "rays deploy",
          test: "gleam test",
        },
        devDependencies: { wrangler: "^4.0.0" },
      },
      null,
      2,
    )}\n`,
    ".gitignore": `/build
/node_modules
/.rays
/.wrangler
.dev.vars*
.env*
`,
  };

  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }

  if (options.install ?? true) {
    const manager = packageManager();
    const code = await exitCode(
      spawn(manager, ["install"], {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
      }),
    ).catch(() => 1);
    if (code !== 0) {
      throw new CliError(
        `The project is in ${root}, but \`${manager} install\` failed. Run it there yourself.`,
      );
    }
  }
  return name;
}

// The package manager that ran rays, so `pnpm dlx` gets pnpm. npm otherwise.
function packageManager(): string {
  const agent = process.env["npm_config_user_agent"] ?? "";
  for (const manager of ["pnpm", "yarn", "bun"]) {
    if (agent.startsWith(`${manager}/`)) return manager;
  }
  return "npm";
}
