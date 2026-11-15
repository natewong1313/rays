/**
 * The `rays` command. Runs in Node.js or Bun, and as a standalone executable
 * compiled with `bun build --compile`.
 *
 * @module
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { build, BuildError } from "@rays/cloudflare/build";

const HELP = `Usage: rays <command> [options]

Commands:
  build    Compile the Gleam project and write Worker entry modules to .rays/

Run \`rays <command> --help\` for a command's options.
`;

const BUILD_HELP = `Usage: rays build [--module <name>]...

Compiles the Gleam project in the current directory to JavaScript, then writes
.rays/<module>.entry.ts, which exports the Worker returned by the module's
\`pub fn main()\`. Point Wrangler at it:

  "main": ".rays/<module>.entry.ts",
  "build": { "command": "rays build", "watch_dir": "src" }

Options:
  -m, --module <name>  The Gleam module whose main() builds the Worker, such
                       as "app" or "app/admin". Repeat it to build several
                       Workers. Defaults to the module named after the
                       package.
  -h, --help           Show this help.

Environment:
  RAYS_GLEAM_BIN       The gleam executable to use. Defaults to gleam on PATH.
`;

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return command === undefined ? 1 : 0;
    case "build":
      return buildCommand(rest);
    default:
      process.stderr.write(`rays: unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
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
  try {
    const entries = await build({ root, modules: values.module });
    for (const entry of entries) {
      if (entry.changed) {
        process.stderr.write(
          `rays build: wrote ${path.relative(root, entry.path)}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof BuildError) {
      process.stderr.write(`rays build: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
