// Finding the project's Durable Object classes, for `rays/durable_object`,
// in its package interface.

import { BuildError } from "./error.ts";
import {
  describeType,
  type ModuleInterface,
  type NamedType,
  type TypeInterface,
} from "./package-interface.ts";

/**
 * A Durable Object class: a public function in the project with no
 * arguments that returns a `durable_object.DurableObject`.
 */
export interface DurableObjectClass {
  /** The Gleam module it is defined in. */
  module: string;
  /** The Gleam function that defines it. */
  function: string;
  /** The name of the class the entry module exports, in PascalCase. */
  className: string;
}

/**
 * The project's Durable Object classes, sorted by class name.
 *
 * @throws {BuildError} If a class can't run on JavaScript, its memory type
 *   is generic, or two classes have the same name.
 */
export function findDurableObjectClasses(
  modules: Record<string, ModuleInterface | undefined>,
): DurableObjectClass[] {
  const classes: DurableObjectClass[] = [];
  for (const [module, moduleInterface] of Object.entries(modules)) {
    for (const [name, fn] of Object.entries(moduleInterface?.functions ?? {})) {
      if (fn.parameters.length > 0 || !isDurableObject(fn.return)) continue;
      const where = `${name} in src/${module}.gleam`;
      if (!fn.implementations["can-run-on-javascript"]) {
        throw new BuildError(
          `${where} returns a durable_object.DurableObject, so it is a Durable Object class, but it can't run on JavaScript.`,
        );
      }
      const memory = fn.return.parameters[0]!;
      if (isGeneric(memory)) {
        throw new BuildError(
          `${where} is a Durable Object class with a generic memory type, ${describeType(memory)}. A class's memory type must be concrete.`,
        );
      }
      classes.push({ module, function: name, className: className(name) });
    }
  }

  classes.sort((a, b) => a.className.localeCompare(b.className));
  for (let i = 1; i < classes.length; i++) {
    const [first, second] = [classes[i - 1]!, classes[i]!];
    if (first.className === second.className) {
      throw new BuildError(
        `${first.function} in src/${first.module}.gleam and ${second.function} in src/${second.module}.gleam are both the Durable Object class ${first.className}. Rename one of them.`,
      );
    }
  }
  return classes;
}

/** The class name for a Gleam function name: `chat_room` is `ChatRoom`. */
export function className(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function isDurableObject(type: TypeInterface): type is NamedType {
  return (
    type.kind === "named" &&
    type.package === "rays" &&
    type.module === "rays/durable_object" &&
    type.name === "DurableObject"
  );
}

function isGeneric(type: TypeInterface): boolean {
  switch (type.kind) {
    case "variable":
      return true;
    case "named":
      return type.parameters.some(isGeneric);
    case "tuple":
      return type.elements.some(isGeneric);
    case "fn":
      return type.parameters.some(isGeneric) || isGeneric(type.return);
  }
}
