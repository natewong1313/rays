/**
 * The `rays` command. Runs in Node.js or Bun, and as a standalone executable
 * compiled with `bun build --compile`.
 *
 * @module
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build, BuildError } from "@rays/core/build";
import {
  CliError,
  readGleamToml,
  readManagedProject,
  writeWranglerConfigs,
  type ManagedProject,
} from "./managed.ts";
import { createProject } from "./new.ts";
import {
  devVarsFiles,
  exitCode,
  hasOption,
  runWrangler,
  selectedEnvironment,
  startWrangler,
  withConfigs,
} from "./wrangler.ts";

const HELP = `Usage: rays <command> [options]

Commands:
  new <directory>  Create a Gleam project for Cloudflare Workers
  dev              Run the project locally with Wrangler
  deploy           Deploy the project's Workers with Wrangler
  build            Compile the Gleam project and write Worker entry modules
  wrangler         Run any Wrangler command on the project

dev, deploy and wrangler need [tools.rays] in gleam.toml, from which rays
writes the Wrangler configuration. build also works on its own, for projects
with their own Wrangler configuration.

Run \`rays <command> --help\` for a command's options.
`;

const BUILD_HELP = `Usage: rays build [--module <name>]...

Compiles the Gleam project in the current directory to JavaScript, then writes
.rays/<module>.entry.ts, which exports the Worker returned by the module's
\`pub fn main()\`.

With [tools.rays] in gleam.toml, it also writes each Worker's Wrangler
configuration into .rays/, and builds every Worker listed there.

Without it, point your own Wrangler configuration at the entry module:

  "main": ".rays/<module>.entry.ts",
  "build": { "command": "rays build", "watch_dir": "src" }

Options:
  -m, --module <name>  The Gleam module whose main() builds the Worker, such
                       as "app" or "app/admin". Repeat it to build several
                       Workers. Defaults to the module named after the
                       package, or with [tools.rays], to its Workers.
  -h, --help           Show this help.

Environment:
  RAYS_GLEAM_BIN       The gleam executable to use. Defaults to gleam on PATH.
`;

const NEW_HELP = `Usage: rays new <directory> [--no-install] [--rays-path <path>]

Creates a Gleam project for Cloudflare Workers in <directory>: gleam.toml with
its Cloudflare settings in [tools.rays], a Worker in src/, a test, and a
package.json that installs Wrangler. Then installs it.

Options:
  --no-install         Don't install the npm dependencies.
  --rays-path <path>   Depend on rays from this directory instead of Hex.
  -h, --help           Show this help.
`;

const DEV_HELP = `Usage: rays dev [wrangler dev options]

Writes the Wrangler configuration from [tools.rays] in gleam.toml and runs
\`wrangler dev\` with it, running every Worker in the project. It rewrites the
configuration when gleam.toml changes. Options are passed to Wrangler, such as
--port or --env.

Local variables come from .dev.vars or .env next to gleam.toml, as Wrangler
reads them, and local data is kept in .wrangler/state.
`;

const DEPLOY_HELP = `Usage: rays deploy [wrangler deploy options]

Writes the Wrangler configuration from [tools.rays] in gleam.toml and runs
\`wrangler deploy\` for each Worker in the project, the primary one last.
Options are passed to Wrangler, such as --env or --dry-run.
`;

const WRANGLER_HELP = `Usage: rays wrangler [--worker <module>] <wrangler command> [options]

Runs a Wrangler command with the configuration rays writes from [tools.rays]
in gleam.toml, such as \`rays wrangler secret put TOKEN\` or
\`rays wrangler d1 migrations apply DB\`.

Options:
  --worker <module>  The Worker to run it for, in a project with several.
                     Must come first. Defaults to the primary Worker.
`;

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case undefined:
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        return command === undefined ? 1 : 0;
      case "build":
        return await buildCommand(rest);
      case "new":
        return await newCommand(rest);
      case "dev":
        return await devCommand(rest);
      case "deploy":
        return await deployCommand(rest);
      case "wrangler":
        return await wranglerCommand(rest);
      default:
        process.stderr.write(`rays: unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof BuildError) {
      process.stderr.write(`rays ${command}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function wantsHelp(args: string[], help: string): boolean {
  const [first] = args;
  if (first !== "-h" && first !== "--help") return false;
  process.stdout.write(help);
  return true;
}

async function buildCommand(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        module: { type: "string", short: "m", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    process.stderr.write(
      `rays build: ${(error as Error).message}\n\n${BUILD_HELP}`,
    );
    return 1;
  }

  if (values.help) {
    process.stdout.write(BUILD_HELP);
    return 0;
  }

  const root = process.cwd();
  let modules = values.module;
  // Without --module, a managed project builds all of its Workers, and
  // writes their configuration. Wrangler's build command passes --module.
  if (modules === undefined) {
    const { project } = await readGleamToml(root);
    if (project !== undefined) {
      await writeConfigs(project, "rays build");
      modules = project.workers.map((worker) => worker.module);
    }
  }

  const entries = await build({ root, modules });
  for (const entry of entries) {
    if (entry.changed) {
      process.stderr.write(
        `rays build: wrote ${path.relative(root, entry.path)}\n`,
      );
    }
  }
  return 0;
}

async function newCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        install: { type: "boolean", default: true },
        "no-install": { type: "boolean" },
        "rays-path": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    process.stderr.write(
      `rays new: ${(error as Error).message}\n\n${NEW_HELP}`,
    );
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(NEW_HELP);
    return 0;
  }
  const [directory, ...extra] = positionals;
  if (directory === undefined || extra.length > 0) {
    process.stderr.write(`rays new: give one directory.\n\n${NEW_HELP}`);
    return 1;
  }

  const name = await createProject({
    directory,
    raysPath: values["rays-path"],
    install: !values["no-install"],
  });
  process.stdout.write(`Created ${name} in ${directory}. Next:

  cd ${directory}
  rays dev
`);
  return 0;
}

async function devCommand(args: string[]): Promise<number> {
  if (wantsHelp(args, DEV_HELP)) return 0;
  const root = process.cwd();
  let project = await readManagedProject(root, "rays dev");
  await writeConfigs(project, "rays dev");

  const environment = selectedEnvironment(args);
  // Wrangler loads every --env-file the way it loads .env files, which
  // CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false turns off. That setting is
  // about .env files, so a .dev.vars file passed this way still loads.
  const env = { ...process.env };
  const wranglerArgs = () => {
    const extra: string[] = [];
    if (!hasOption(args, "--env-file")) {
      const files = devVarsFiles(root, environment);
      for (const file of files) extra.push("--env-file", file);
      if (files.some((file) => path.basename(file).startsWith(".dev.vars"))) {
        env["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] = "true";
      }
    }
    // Wrangler keeps local data next to its configuration file; keep it in
    // the project instead, where it survives .rays/ being rewritten.
    if (!hasOption(args, "--persist-to")) {
      extra.push("--persist-to", path.join(".wrangler", "state"));
    }
    return withConfigs(
      ["dev", ...args, ...extra],
      project.workers.map((worker) => path.relative(root, worker.configPath)),
    );
  };

  let child: ChildProcess = startWrangler(root, wranglerArgs(), env);
  let restarting = false;

  // Rewrite the configuration when gleam.toml changes. Wrangler reloads a
  // configuration that changes, but not the set of them it was started
  // with, so a change to the Workers restarts it.
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(root, (_event, file) => {
    if (file !== "gleam.toml") return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const next = await readManagedProject(root, "rays dev");
        await writeConfigs(next, "rays dev");
        const workers = (p: ManagedProject) =>
          p.workers.map((worker) => worker.configPath).join("\n");
        const restart = workers(next) !== workers(project);
        project = next;
        if (restart) {
          process.stderr.write(
            "rays dev: the Workers in gleam.toml changed, so Wrangler is restarting.\n",
          );
          restarting = true;
          child.kill("SIGINT");
        }
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        process.stderr.write(
          `rays dev: ${error.message}\nrays dev: keeping the last good configuration.\n`,
        );
      }
    }, 100);
  });

  // Pass stop signals on to Wrangler and wait for it to finish, whether they
  // came from the terminal, which signals both, or only to rays.
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    for (;;) {
      const code = await exitCode(child);
      if (!restarting) return code;
      restarting = false;
      child = startWrangler(root, wranglerArgs(), env);
    }
  } finally {
    watcher.close();
    clearTimeout(timer);
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

async function deployCommand(args: string[]): Promise<number> {
  if (wantsHelp(args, DEPLOY_HELP)) return 0;
  const root = process.cwd();
  const project = await readManagedProject(root, "rays deploy");
  await writeConfigs(project, "rays deploy");

  // The Workers the primary one binds to go first, so they exist when it
  // deploys.
  const [primary, ...others] = project.workers;
  for (const worker of [...others, primary!]) {
    if (project.workers.length > 1) {
      process.stderr.write(`rays deploy: deploying ${worker.module}\n`);
    }
    const code = await runWrangler(
      root,
      withConfigs(
        ["deploy", ...args],
        [path.relative(root, worker.configPath)],
      ),
    );
    if (code !== 0) return code;
  }
  return 0;
}

async function wranglerCommand(args: string[]): Promise<number> {
  if (wantsHelp(args, WRANGLER_HELP)) return 0;
  const root = process.cwd();
  const project = await readManagedProject(root, "rays wrangler");

  let rest = args;
  let worker = project.workers[0]!;
  if (args[0] === "--worker") {
    const module = args[1];
    const chosen = project.workers.find((w) => w.module === module);
    if (chosen === undefined) {
      throw new CliError(
        `There is no Worker "${module ?? ""}" in gleam.toml. The Workers are ${project.workers.map((w) => w.module).join(", ")}.`,
      );
    }
    worker = chosen;
    rest = args.slice(2);
  }
  if (rest.length === 0) {
    process.stderr.write(
      `rays wrangler: give a Wrangler command.\n\n${WRANGLER_HELP}`,
    );
    return 1;
  }

  await writeConfigs(project, "rays wrangler");
  return runWrangler(
    root,
    withConfigs(rest, [path.relative(root, worker.configPath)]),
  );
}

async function writeConfigs(
  project: ManagedProject,
  command: string,
): Promise<void> {
  if (await writeWranglerConfigs(project, raysCommand())) {
    process.stderr.write(
      `${command}: wrote the Wrangler configuration in .rays/\n`,
    );
  }
}

/**
 * The shell command that runs this rays, for Wrangler's build command. Its
 * paths are absolute, so it works whatever PATH Wrangler runs it with.
 */
function raysCommand(): string {
  const quote = (value: string) => {
    if (value.includes('"')) {
      throw new CliError(`rays can't run from a path with a quote: ${value}`);
    }
    return `"${value}"`;
  };
  // A compiled rays is its own executable. Its script is embedded, at a path
  // Bun makes up: /$bunfs/... on Unix, B:\~BUN\... on Windows.
  const script = process.argv[1];
  const embedded =
    script === undefined ||
    script.startsWith("/$bunfs/") ||
    /^[A-Z]:\\~BUN\\/i.test(script) ||
    !existsSync(script);
  if (embedded) return quote(process.execPath);
  return `${quote(process.execPath)} ${quote(path.resolve(script))}`;
}

process.exitCode = await main(process.argv.slice(2));
