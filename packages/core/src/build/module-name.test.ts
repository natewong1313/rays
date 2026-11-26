// Tests which names are Gleam module names: lowercase segments joined by
// slashes, each starting with a letter.

import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { isModuleName, notAModuleName } from "./module-name.ts";

const letter = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz");
const letterDigitOrUnderscore = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789_",
);
const segment = fc
  .tuple(letter, fc.string({ unit: letterDigitOrUnderscore }))
  .map(([first, rest]) => first + rest);

/** A Gleam module name, such as "app" or "app/admin_api". */
const moduleName = fc
  .array(segment, { minLength: 1 })
  .map((segments) => segments.join("/"));

/** Whether `character` can appear somewhere in a module name. */
const allowed = (character: string) => /[a-z0-9_/]/.test(character);

/** Every printable ASCII character that can't appear in a module name. */
const foreignAscii = Array.from({ length: 95 }, (_, i) =>
  String.fromCharCode(32 + i),
).filter((character) => !allowed(character));

/** Any one code point that can't appear in a module name. */
const foreignCharacter = fc
  .string({ unit: "binary", minLength: 1, maxLength: 1 })
  .filter((character) => !allowed(character));

describe("isModuleName", () => {
  it("accepts a module and a nested module", () => {
    expect(isModuleName("app")).toBe(true);
    expect(isModuleName("app/admin")).toBe(true);
    expect(isModuleName("my_app/v2/routes")).toBe(true);
  });

  it.each([
    ["an empty name", ""],
    ["a capital letter", "App"],
    ["a dash", "my-app"],
    ["a leading digit", "1app"],
    ["a leading underscore", "_app"],
    ["an empty segment", "app//admin"],
    ["a file extension", "app.gleam"],
  ])("rejects %s", (_, name) => {
    expect(isModuleName(name)).toBe(false);
  });

  it.prop([moduleName])(
    "accepts any name built from valid segments",
    (name) => {
      expect(isModuleName(name)).toBe(true);
    },
  );

  it.each(foreignAscii)("rejects %j in a name", (character) => {
    expect(isModuleName(`app${character}`)).toBe(false);
    expect(isModuleName(`app/${character}admin`)).toBe(false);
  });

  it.prop([moduleName])("rejects a leading or trailing slash", (name) => {
    expect(isModuleName(`/${name}`)).toBe(false);
    expect(isModuleName(`${name}/`)).toBe(false);
  });

  it.prop([moduleName, foreignCharacter, fc.nat()])(
    "rejects a name with any other character in it",
    (name, character, index) => {
      const at = index % (name.length + 1);
      const changed = name.slice(0, at) + character + name.slice(at);
      expect(isModuleName(changed)).toBe(false);
    },
  );

  it.prop([moduleName, fc.constantFrom(..."0123456789_"), fc.nat()])(
    "rejects a segment that doesn't start with a letter",
    (name, start, index) => {
      const segments = name.split("/");
      const at = index % segments.length;
      segments[at] = start + segments[at];
      expect(isModuleName(segments.join("/"))).toBe(false);
    },
  );
});

describe("notAModuleName", () => {
  it.prop([fc.string()])("quotes the name it explains", (name) => {
    expect(notAModuleName(name)).toContain(`"${name}"`);
  });
});
