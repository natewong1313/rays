// Finding the SQL migrations of a project's Durable Object classes, for
// `rays/durable_object/sql`.
//
// A class's migrations are the `.sql` files in the `migrations` directory
// beside the module that defines it: `src/app/notes.gleam` has those in
// `src/app/notes/migrations/`, in the order of their file names. The build
// hands them to the class in the Worker's entry module, and
// `sql.apply_migrations` runs them, so the project's code never names them
// and nothing is generated in `src/`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DurableObjectClass } from "./durable-object.ts";
import { BuildError } from "./error.ts";

/** The name of the directory whose `.sql` files are a class's migrations. */
const MIGRATIONS_DIR = "migrations";

/** A migration: a script of SQL, named after its file without `.sql`. */
export interface Migration {
  name: string;
  sql: string;
}

/**
 * The migrations of each class that has any, by its class name.
 *
 * @throws {BuildError} If a module with migrations defines more than one
 *   class, so it isn't known which of them they are for.
 */
export function findMigrations(
  root: string,
  classes: readonly DurableObjectClass[],
): Map<string, Migration[]> {
  const byModule = new Map<string, DurableObjectClass[]>();
  for (const object of classes) {
    byModule.set(object.module, [
      ...(byModule.get(object.module) ?? []),
      object,
    ]);
  }

  const found = new Map<string, Migration[]>();
  for (const [module, objects] of byModule) {
    const dir = path.join(root, "src", module, MIGRATIONS_DIR);
    const migrations = readMigrations(dir);
    if (migrations.length === 0) continue;
    if (objects.length > 1) {
      const names = objects.map((object) => object.function).join(" and ");
      throw new BuildError(
        `src/${module}/${MIGRATIONS_DIR}/ holds migrations, but src/${module}.gleam defines more than one Durable Object class (${names}), so rays doesn't know which one they are for. Move each class with migrations into a module of its own.`,
      );
    }
    found.set(objects[0]!.className, migrations);
  }
  return found;
}

// The `.sql` files in `dir`, in the order of their names, or none if it
// doesn't exist.
function readMigrations(dir: string): Migration[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareNames)
    .map((name) => ({
      name: name.slice(0, -".sql".length),
      sql: readFileSync(path.join(dir, name), "utf8"),
    }));
}

// By code point, so the order doesn't depend on the locale.
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
