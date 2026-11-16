/**
 * Projects managed by rays: Cloudflare settings live in `[tools.rays]` in
 * gleam.toml, and rays writes the Wrangler configuration from them.
 *
 * ```toml
 * [tools.rays.wrangler]
 * compatibility_date = "2026-09-01"
 *
 * [tools.rays.wrangler.vars]
 * GREETING = "Hello"
 * ```
 *
 * `[tools.rays.wrangler]` takes anything a `wrangler.toml` does, except
 * `main` and `build`, which rays sets. Paths in it are relative to
 * gleam.toml. A project with several Workers lists them under
 * `[tools.rays.workers.<module>]`, each with its own `wrangler` table that is
 * merged over the shared one.
 *
 * @module
 */

import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse, TomlError } from "smol-toml";

/** The directory, next to gleam.toml, that rays writes into. */
export const OUTPUT_DIR = ".rays";

/** A failure with a message meant for the developer. */
export class CliError extends Error {
  override name = "CliError";
}

/** A Worker in a managed project. */
export interface ManagedWorker {
  /** The Gleam module whose `pub fn main()` builds the Worker. */
  module: string;
  /** The absolute path of the Wrangler configuration rays writes for it. */
  configPath: string;
  /** Its `[tools.rays.wrangler]` settings, merged and with paths unchanged. */
  wrangler: Record<string, unknown>;
}

/** A project with `[tools.rays]` in its gleam.toml. */
export interface ManagedProject {
  root: string;
  packageName: string;
  /** The project's Workers, the primary one first. */
  workers: ManagedWorker[];
}

const CONFIG_FILES = [
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
  "cloudflare.config.ts",
];

// Rays sets these itself, so `[tools.rays.wrangler]` can't.
const RAYS_KEYS = ["main", "build"];

/**
 * Read the gleam.toml in `root`, returning `undefined` if it has no
 * `[tools.rays]`.
 *
 * @throws {CliError} If there is no gleam.toml, or `[tools.rays]` is invalid.
 */
export async function readGleamToml(
  root: string,
): Promise<{ packageName: string; project: ManagedProject | undefined }> {
  const file = path.join(root, "gleam.toml");
  let toml: Record<string, unknown>;
  try {
    toml = withDatesAsText(parse(await readFile(file, "utf8"))) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(
        `No gleam.toml in ${root}. Run rays from the directory that holds gleam.toml and package.json.`,
      );
    }
    if (error instanceof TomlError) {
      throw new CliError(`gleam.toml is not valid TOML: ${error.message}`);
    }
    throw error;
  }

  const packageName = toml["name"];
  if (typeof packageName !== "string") {
    throw new CliError("gleam.toml has no name.");
  }

  const tools = toml["tools"];
  const settings = isTable(tools) ? tools["rays"] : undefined;
  if (settings === undefined) return { packageName, project: undefined };

  return {
    packageName,
    project: {
      root,
      packageName,
      workers: readWorkers(root, packageName, settings),
    },
  };
}

/**
 * Read the managed project in `root`.
 *
 * @throws {CliError} If gleam.toml has no `[tools.rays]`, explaining what the
 *   command needs.
 */
export async function readManagedProject(
  root: string,
  command: string,
): Promise<ManagedProject> {
  const { project } = await readGleamToml(root);
  if (project === undefined) {
    throw new CliError(
      `${command} runs Wrangler with the settings in [tools.rays] in gleam.toml, and gleam.toml has none. Add a [tools.rays.wrangler] table with at least compatibility_date, or run Wrangler yourself with your own configuration.`,
    );
  }
  return project;
}

function readWorkers(
  root: string,
  packageName: string,
  settings: unknown,
): ManagedWorker[] {
  if (!isTable(settings)) {
    throw new CliError("[tools.rays] in gleam.toml must be a table.");
  }
  checkKeys(settings, "[tools.rays]", ["wrangler", "workers", "module"]);

  for (const file of CONFIG_FILES) {
    if (existsSync(path.join(root, file))) {
      throw new CliError(
        `gleam.toml has [tools.rays], so rays writes the Wrangler configuration, but there is also a ${file}. Keep one: move its settings into [tools.rays.wrangler], or remove [tools.rays] to use ${file} yourself.`,
      );
    }
  }

  const shared = wranglerTable(settings["wrangler"], "[tools.rays.wrangler]");
  const workers = settings["workers"];

  if (workers === undefined) {
    const module = settings["module"] ?? packageName;
    if (typeof module !== "string" || !isModuleName(module)) {
      throw new CliError(
        `module in [tools.rays] must be a Gleam module name, such as "app" or "app/admin".`,
      );
    }
    return [
      {
        module,
        configPath: path.join(root, OUTPUT_DIR, "wrangler.jsonc"),
        wrangler: withDefaultName(shared, packageName, module),
      },
    ];
  }

  if (settings["module"] !== undefined) {
    throw new CliError(
      "[tools.rays] can't have both module and workers. List each Worker's module under [tools.rays.workers] instead.",
    );
  }
  if (!isTable(workers) || Object.keys(workers).length === 0) {
    throw new CliError(
      `[tools.rays.workers] must have a table for each Worker, such as [tools.rays.workers."app/admin"].`,
    );
  }

  const read: (ManagedWorker & { primary: boolean })[] = [];
  for (const [module, worker] of Object.entries(workers)) {
    const where = `[tools.rays.workers.${tomlKey(module)}]`;
    if (!isModuleName(module)) {
      throw new CliError(
        `${where}: "${module}" is not a Gleam module name. Module names look like "app" or "app/admin".`,
      );
    }
    if (!isTable(worker)) throw new CliError(`${where} must be a table.`);
    checkKeys(worker, where, ["primary", "wrangler"]);
    const primary = worker["primary"] ?? false;
    if (typeof primary !== "boolean") {
      throw new CliError(`primary in ${where} must be true or false.`);
    }
    const own = wranglerTable(
      worker["wrangler"],
      `[tools.rays.workers.${tomlKey(module)}.wrangler]`,
    );
    read.push({
      module,
      primary,
      configPath: path.join(root, OUTPUT_DIR, `${module}.wrangler.jsonc`),
      wrangler: withDefaultName(merge(shared, own), packageName, module),
    });
  }

  const primaries = read.filter((worker) => worker.primary);
  if (primaries.length > 1) {
    throw new CliError(
      `Only one Worker can be primary, but ${primaries.map((worker) => `"${worker.module}"`).join(" and ")} both are.`,
    );
  }
  // The primary Worker is the one marked so, or else the first listed.
  const primary = primaries[0] ?? read[0]!;
  return [primary, ...read.filter((worker) => worker !== primary)].map(
    ({ primary: _, ...worker }) => worker,
  );
}

function wranglerTable(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isTable(value)) throw new CliError(`${where} must be a table.`);
  const tables = [value, ...Object.values(tableOr(value["env"]))];
  for (const table of tables) {
    for (const key of RAYS_KEYS) {
      if (isTable(table) && key in table) {
        throw new CliError(
          `${where} sets ${key}, which rays sets itself. Remove it: rays builds the Worker from the Gleam module's pub fn main().`,
        );
      }
    }
  }
  return value;
}

/**
 * The name of a Worker that doesn't set one: the package's name, followed by
 * the module's unless it is the one named after the package, with dashes
 * for underscores and slashes. `app/admin` in the `app` package is
 * `app-admin`.
 */
export function defaultWorkerName(packageName: string, module: string): string {
  const prefix = `${packageName}/`;
  const rest = module.startsWith(prefix) ? module.slice(prefix.length) : module;
  const name = module === packageName ? packageName : `${packageName}-${rest}`;
  return name.replaceAll(/[_/]/g, "-");
}

function withDefaultName(
  wrangler: Record<string, unknown>,
  packageName: string,
  module: string,
): Record<string, unknown> {
  if (wrangler["name"] !== undefined) return wrangler;
  return { name: defaultWorkerName(packageName, module), ...wrangler };
}

/**
 * The Wrangler configuration for a Worker: its settings, with paths made
 * relative to the configuration file, and the `main` and `build` that build
 * it with `rays build`.
 *
 * @param rays The shell command that runs this rays.
 */
export function wranglerConfig(
  project: ManagedProject,
  worker: ManagedWorker,
  rays: string,
): Record<string, unknown> {
  const directory = path.dirname(worker.configPath);
  const rebase = (file: string) =>
    path.isAbsolute(file)
      ? file
      : relative(directory, path.resolve(project.root, file));

  const config = rebasePaths(worker.wrangler, rebase);
  if (config["compatibility_date"] === undefined) {
    throw new CliError(
      `The ${worker.module} Worker has no compatibility_date. Add one to [tools.rays.wrangler] in gleam.toml, such as compatibility_date = "${today()}".`,
    );
  }

  return {
    ...config,
    main: relative(
      directory,
      path.join(project.root, OUTPUT_DIR, `${worker.module}.entry.ts`),
    ),
    build: {
      command: `${rays} build --module ${worker.module}`,
      // Wrangler runs the command in `cwd` as given, relative to where it
      // runs, so it's absolute here. It joins `watch_dir` onto the
      // configuration file's directory, so that one has to be relative.
      cwd: project.root,
      watch_dir: relative(directory, path.join(project.root, "src")),
    },
  };
}

/**
 * Write the Wrangler configuration of each Worker into `.rays/`, leaving
 * unchanged files alone so Wrangler doesn't reload for nothing.
 *
 * @returns Whether any file changed.
 */
export async function writeWranglerConfigs(
  project: ManagedProject,
  rays: string,
): Promise<boolean> {
  // Make every configuration before writing any, so an error writes none.
  const configs = project.workers.map(
    (worker) =>
      [worker.configPath, wranglerConfig(project, worker, rays)] as const,
  );

  await mkdir(path.join(project.root, OUTPUT_DIR), { recursive: true });
  await writeIfChanged(
    path.join(project.root, OUTPUT_DIR, ".gitignore"),
    "*\n",
  );

  let changed = await removeStaleConfigs(
    project,
    new Set(configs.map(([file]) => file)),
  );
  for (const [file, config] of configs) {
    const contents = `// Generated by rays from [tools.rays] in gleam.toml. Do not edit: it is
// rewritten whenever rays runs. Change gleam.toml instead.
${JSON.stringify(config, null, 2)}
`;
    if (await writeIfChanged(file, contents)) changed = true;
  }
  return changed;
}

// Remove configuration files for Workers that gleam.toml no longer lists, so
// they can't be run by mistake.
async function removeStaleConfigs(
  project: ManagedProject,
  keep: Set<string>,
): Promise<boolean> {
  const directory = path.join(project.root, OUTPUT_DIR);
  let removed = false;
  for (const entry of await readdir(directory, { recursive: true })) {
    const file = path.join(directory, entry);
    const name = path.basename(file);
    const isConfig =
      name === "wrangler.jsonc" || name.endsWith(".wrangler.jsonc");
    if (isConfig && !keep.has(file)) {
      await rm(file, { force: true });
      removed = true;
    }
  }
  return removed;
}

// Settings whose values are paths, relative to the configuration file.
function rebasePaths(
  config: Record<string, unknown>,
  rebase: (file: string) => string,
): Record<string, unknown> {
  const result = structuredClone(config);
  const tables = [result, ...Object.values(tableOr(result["env"]))];
  for (const table of tables) {
    if (!isTable(table)) continue;
    for (const key of ["base_dir", "tsconfig"]) {
      if (typeof table[key] === "string") table[key] = rebase(table[key]);
    }
    for (const [section, key] of [
      ["assets", "directory"],
      ["site", "bucket"],
    ] as const) {
      const value = table[section];
      if (isTable(value) && typeof value[key] === "string") {
        value[key] = rebase(value[key]);
      }
    }
    for (const database of arrayOr(table["d1_databases"])) {
      if (isTable(database) && typeof database["migrations_dir"] === "string") {
        database["migrations_dir"] = rebase(database["migrations_dir"]);
      }
    }
    // An image is a registry reference or a path to a Dockerfile.
    for (const container of arrayOr(table["containers"])) {
      if (isTable(container) && isRelativePath(container["image"])) {
        container["image"] = rebase(container["image"]);
      }
    }
    const alias = table["alias"];
    if (isTable(alias)) {
      for (const [name, target] of Object.entries(alias)) {
        if (isRelativePath(target)) alias[name] = rebase(target);
      }
    }
  }
  return result;
}

function isRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("./") || value.startsWith("../"))
  );
}

// Tables merge key by key; anything else, arrays included, is replaced.
function merge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = result[key];
    result[key] =
      isTable(existing) && isTable(value) ? merge(existing, value) : value;
  }
  return result;
}

function checkKeys(
  table: Record<string, unknown>,
  where: string,
  allowed: string[],
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      throw new CliError(
        `${where} in gleam.toml has an unknown setting "${key}". It can have ${allowed.join(", ")}. Wrangler settings go in its wrangler table.`,
      );
    }
  }
}

/** Whether `name` is a Gleam module name, such as "app" or "app/admin". */
export function isModuleName(name: string): boolean {
  return /^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)*$/.test(name);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

// TOML dates as they were written, such as "2026-09-01", which is how
// Wrangler takes compatibility_date.
function withDatesAsText(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(withDatesAsText);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withDatesAsText(item)]),
    );
  }
  return value;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function tableOr(value: unknown): Record<string, unknown> {
  return isTable(value) ? value : {};
}

function arrayOr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function relative(from: string, to: string): string {
  const file = path.relative(from, to).split(path.sep).join("/");
  if (file === "") return ".";
  return file.startsWith(".") ? file : `./${file}`;
}

/** Today's date, as Wrangler's compatibility_date takes it. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Write through a temporary file, so a watcher never sees half a file, and
 * leave unchanged files alone.
 *
 * @returns Whether the file changed.
 */
export async function writeIfChanged(
  file: string,
  contents: string,
): Promise<boolean> {
  try {
    if ((await readFile(file, "utf8")) === contents) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
  return true;
}
