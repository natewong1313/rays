import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TypeInterface } from "../package-interface.ts";
import { stripFooter } from "./footers.ts";
import { RpcBuildError, type RpcContext } from "./types.ts";

// A method's version is a hash of its argument and reply types, and of
// everything that decides how the values in them are encoded:
//
// - for a type defined in the project, its constructors and their fields;
//   for an opaque, private or external one, whose constructors the package
//   interface doesn't show, its definition in the source, and the types
//   that definition names
// - for a type from a Hex package, the package's version
// - for a type from a path or Git dependency, its compiled code
//
// So a change to a method's handler, or to code its types don't depend on,
// leaves its version alone.
export class Versions {
  #context: RpcContext;
  #packages:
    Promise<Map<string, { version: string; source: string }>> | undefined;
  #hashes = new Map<string, Promise<string>>();
  #sources = new Map<string, Promise<string | undefined>>();
  #built: Promise<string[]> | undefined;

  constructor(context: RpcContext) {
    this.#context = context;
  }

  async of(
    where: string,
    args: TypeInterface,
    reply: TypeInterface,
  ): Promise<string> {
    const parts = new Map<string, string>();
    await this.#walk(where, args, parts, false);
    await this.#walk(where, reply, parts, false);
    const hash = createHash("sha256");
    hash.update(JSON.stringify([args, reply]));
    for (const key of [...parts.keys()].sort())
      hash.update(`\0${key}\0${parts.get(key)}`);
    return hash.digest("hex").slice(0, 16);
  }

  async #walk(
    where: string,
    type: TypeInterface,
    parts: Map<string, string>,
    inDefinition: boolean,
  ): Promise<void> {
    switch (type.kind) {
      case "variable":
        if (!inDefinition) {
          throw new RpcBuildError(
            `${where} is generic. An RPC method's argument and reply types must be concrete, so both Workers agree on them.`,
          );
        }
        return;
      case "fn":
        throw new RpcBuildError(
          `${where} sends a function, which can't be sent between Workers.`,
        );
      case "tuple":
        for (const element of type.elements) {
          await this.#walk(where, element, parts, inDefinition);
        }
        return;
      case "named":
        for (const parameter of type.parameters) {
          await this.#walk(where, parameter, parts, inDefinition);
        }
        await this.#named(where, type, parts);
    }
  }

  async #named(
    where: string,
    type: Extract<TypeInterface, { kind: "named" }>,
    parts: Map<string, string>,
  ): Promise<void> {
    await this.#type(where, type.package, type.module, type.name, parts);
  }

  // Add the definition of the type `name`, in `module` of `packageName`, and
  // of the types it refers to, to `parts`.
  async #type(
    where: string,
    packageName: string,
    module: string,
    name: string,
    parts: Map<string, string>,
  ): Promise<void> {
    // The prelude's types, such as Int and List, are part of the compiler.
    if (packageName === "") return;
    const key = `${packageName}:${module}.${name}`;
    if (parts.has(key)) return;

    if (packageName !== this.#context.packageName) {
      parts.set(key, await this.#packageVersion(packageName));
      return;
    }

    // A public type's constructors are in the package interface, with their
    // fields' types already resolved.
    const definition = this.#context.modules[module]?.types[name];
    if (definition !== undefined && definition.constructors.length > 0) {
      const constructors = definition.constructors.map((constructor) => ({
        name: constructor.name,
        fields: constructor.parameters,
      }));
      parts.set(key, JSON.stringify([definition.parameters, constructors]));
      for (const constructor of constructors) {
        for (const field of constructor.fields) {
          await this.#walk(where, field.type, parts, true);
        }
      }
      return;
    }

    // An opaque, private or external type's aren't, so its definition is read
    // from the source, and the types it names are followed from there. Only
    // the definition counts, so changing the module's functions doesn't
    // change the version.
    const source = await this.#source(module);
    const found = source && typeDefinition(source, name);
    if (!found) {
      parts.set(key, "unknown");
      return;
    }
    parts.set(key, found.replace(/\s+/g, " "));
    for (const reference of typeReferences(source, module, found)) {
      await this.#type(
        where,
        await this.#packageOf(reference.module, module),
        reference.module,
        reference.name,
        parts,
      );
    }
  }

  #source(module: string): Promise<string | undefined> {
    const file = path.join(this.#context.root, "src", `${module}.gleam`);
    let source = this.#sources.get(file);
    if (source === undefined) {
      source = readFile(file, "utf8").then(
        (text) => text.replace(/\/\/[^\n]*/g, ""),
        () => undefined,
      );
      this.#sources.set(file, source);
    }
    return source;
  }

  // The package a module belongs to: this one if it has the module's source,
  // otherwise the dependency whose build directory has it compiled.
  async #packageOf(module: string, from: string): Promise<string> {
    if (module === from || (await this.#source(module)) !== undefined) {
      return this.#context.packageName;
    }
    for (const packageName of await this.#builtPackages()) {
      try {
        await readFile(this.#compiled(packageName, module));
        return packageName;
      } catch {}
    }
    return `unknown package of ${module}`;
  }

  #builtPackages(): Promise<string[]> {
    this.#built ??= readdir(this.#context.javascript).catch(() => []);
    return this.#built;
  }

  #compiled(packageName: string, module: string): string {
    return path.join(this.#context.javascript, packageName, `${module}.mjs`);
  }

  async #packageVersion(packageName: string): Promise<string> {
    this.#packages ??= readManifest(this.#context.root);
    const found = (await this.#packages).get(packageName);
    if (found?.source === "hex") return `${found.version}`;
    // A path or Git dependency can change without a new version.
    return this.#hashDirectory(
      path.join(this.#context.javascript, packageName),
    );
  }

  #hashDirectory(directory: string): Promise<string> {
    let hash = this.#hashes.get(directory);
    if (hash === undefined) {
      hash = (async () => {
        const digest = createHash("sha256");
        for (const file of (await packageFiles(directory)).sort()) {
          digest.update(`\0${path.relative(directory, file)}\0`);
          digest.update(stripFooter(await readFile(file, "utf8")));
        }
        return digest.digest("hex");
      })();
      this.#hashes.set(directory, hash);
    }
    return hash;
  }
}

// The packages in manifest.toml, which Gleam writes one per line.
async function readManifest(
  root: string,
): Promise<Map<string, { version: string; source: string }>> {
  const packages = new Map<string, { version: string; source: string }>();
  let toml: string;
  try {
    toml = await readFile(path.join(root, "manifest.toml"), "utf8");
  } catch {
    return packages;
  }
  for (const line of toml.split("\n")) {
    const name = /\bname = "([^"]+)"/.exec(line)?.[1];
    const version = /\bversion = "([^"]+)"/.exec(line)?.[1];
    const source = /\bsource = "([^"]+)"/.exec(line)?.[1];
    if (name && version && source) packages.set(name, { version, source });
  }
  return packages;
}

// Reading type definitions from Gleam source, for the types whose fields
// the package interface doesn't show. `source` has had its comments removed.

// The definition of the type `name`: its header and body in braces, or for
// one without a body, such as an external type or an alias, its header and
// any indented lines after it, which is how `gleam format` wraps it.
function typeDefinition(source: string, name: string): string | undefined {
  const header = new RegExp(
    `^(?:pub\\s+)?(?:opaque\\s+)?type\\s+${name}\\b[^{\\n]*`,
    "m",
  ).exec(source);
  if (header === null) return undefined;
  const start = header.index;
  let end = start + header[0].length;
  if (source[end] === "{") {
    let depth = 0;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      if (source[end] === "}" && --depth === 0)
        return source.slice(start, end + 1);
    }
    return source.slice(start);
  }
  const lines = source.slice(start).split("\n");
  let length = 1;
  while (length < lines.length && /^\s+\S/.test(lines[length]!)) length++;
  return lines.slice(0, length).join("\n");
}

// The types a definition names, resolved through the module's imports. A
// constructor's name is also a capitalised name; it either resolves to a
// type, which only adds to the version, or is skipped.
function typeReferences(
  source: string,
  module: string,
  definition: string,
): { module: string; name: string }[] {
  const qualified = new Map<string, string>();
  const unqualified = new Map<string, { module: string; name: string }>();
  const imports =
    /^import\s+([a-z][\w/]*)(?:\.\{([^}]*)\})?(?:\s+as\s+(\w+))?/gm;
  for (const [, imported, items, alias] of source.matchAll(imports)) {
    qualified.set(alias ?? imported!.split("/").pop()!, imported!);
    for (const item of (items ?? "").split(",")) {
      const type = /^\s*type\s+(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
      if (type) {
        unqualified.set(type[2] ?? type[1]!, {
          module: imported!,
          name: type[1]!,
        });
      }
    }
  }
  const own = /^(?:pub\s+)?(?:opaque\s+)?type\s+([A-Z]\w*)/gm;
  const defined = new Set([...source.matchAll(own)].map((match) => match[1]!));

  const references: { module: string; name: string }[] = [];
  const names = /\b(?:([a-z]\w*)\.)?([A-Z]\w*)\b/g;
  for (const [, qualifier, name] of definition.matchAll(names)) {
    if (qualifier !== undefined) {
      const target = qualified.get(qualifier);
      if (target !== undefined)
        references.push({ module: target, name: name! });
    } else if (unqualified.has(name!)) {
      references.push(unqualified.get(name!)!);
    } else if (defined.has(name!)) {
      references.push({ module, name: name! });
    }
    // Anything else is a constructor's name or one of the prelude's types.
  }
  return references;
}

// Every file in a package's build directory but Gleam's own caches,
// including FFI modules in any language, such as `.js`.
async function packageFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.endsWith(".tmp") &&
        !path
          .relative(directory, entry.parentPath)
          .split(path.sep)
          .includes("_gleam_artefacts"),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}
