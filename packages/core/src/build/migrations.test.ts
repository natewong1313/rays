// Tests how `compile` finds the SQL migrations of Durable Object classes, for
// `rays/durable_object/sql`, against a real Gleam compiler.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BuildError, compile } from "../build.ts";
import { useFixture } from "../../test/fixture.ts";

const fixture = useFixture();
const write = (file: string, contents: string) => fixture.write(file, contents);

// A module defining a Durable Object class for each of the function names.
function classes(...names: string[]): string {
  return (
    "import rays/durable_object.{type DurableObject}\n" +
    names
      .map(
        (name) =>
          `\npub fn ${name}() -> DurableObject(Nil) {\n  durable_object.new(Nil)\n}\n`,
      )
      .join("")
  );
}

async function migrationsOf(className: string) {
  const project = await compile({ root: fixture.root });
  return project.durableObjects?.classes.find(
    (object) => object.className === className,
  )?.migrations;
}

describe("a class's migrations", () => {
  it("are the .sql files beside its module, in the order of their names", async () => {
    await write("src/app/notes.gleam", classes("notes"));
    await write(
      "src/app/notes/migrations/0002_index.sql",
      "create index notes_by_body on notes (body);\n",
    );
    await write(
      "src/app/notes/migrations/0001_create.sql",
      'create table notes (\n  body text not null default "\\"\n);\n',
    );
    await write("src/app/notes/migrations/README.md", "Not a migration.\n");

    expect(await migrationsOf("Notes")).toEqual([
      {
        name: "0001_create",
        sql: 'create table notes (\n  body text not null default "\\"\n);\n',
      },
      {
        name: "0002_index",
        sql: "create index notes_by_body on notes (body);\n",
      },
    ]);
  });

  it("are read again on each build", async () => {
    await write("src/app/notes.gleam", classes("notes"));
    await write(
      "src/app/notes/migrations/0001_create.sql",
      "create table t (a);",
    );
    await compile({ root: fixture.root });
    await write(
      "src/app/notes/migrations/0002_more.sql",
      "create table u (b);",
    );

    expect((await migrationsOf("Notes"))?.map((m) => m.name)).toEqual([
      "0001_create",
      "0002_more",
    ]);
  });

  it("are undefined for a class without a migrations directory, or with no .sql files in it", async () => {
    await write("src/app/notes.gleam", classes("notes"));
    await write("src/app/rooms.gleam", classes("rooms"));
    await write("src/app/rooms/migrations/notes.txt", "Nothing here.\n");

    expect(await migrationsOf("Notes")).toBeUndefined();
    expect(await migrationsOf("Rooms")).toBeUndefined();
  });

  it("don't generate anything in src/", async () => {
    await write("src/app/notes.gleam", classes("notes"));
    await write(
      "src/app/notes/migrations/0001_create.sql",
      "create table t (a);",
    );
    await compile({ root: fixture.root });

    expect(await readdir(path.join(fixture.root, "src/app"))).toEqual([
      "notes",
      "notes.gleam",
    ]);
  });

  it("can't belong to a module with more than one class", async () => {
    await write("src/app/places.gleam", classes("rooms", "lobbies"));
    await write(
      "src/app/places/migrations/0001_create.sql",
      "create table t (a);",
    );

    const error = await compile({ root: fixture.root }).catch((e) => e);
    expect(error).toBeInstanceOf(BuildError);
    expect(error.message).toMatch(
      /^src\/app\/places\/migrations\/ holds migrations, but src\/app\/places\.gleam defines more than one Durable Object class \((rooms and lobbies|lobbies and rooms)\), so rays doesn't know which one they are for\. Move each class with migrations into a module of its own\.$/,
    );
  });

  it("let a module with more than one class have no migrations", async () => {
    await write("src/app/places.gleam", classes("rooms", "lobbies"));

    expect(await migrationsOf("Rooms")).toBeUndefined();
  });
});
