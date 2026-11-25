// The footers appended to compiled modules, which register their custom
// types, RPC methods and Durable Object classes with rays/worker_rpc's FFI.

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DurableObjectClass } from "../durable-object.ts";
import { BuildError } from "../error.ts";
import { relativeSpecifier, writeAtomically } from "../files.ts";
import type { RpcContext, RpcMethod } from "./types.ts";

/** The first line of a footer, which marks where it starts. */
export const FOOTER_MARKER = "// rays:rpc";

// A compiled Gleam module that defines a custom type imports the prelude's
// `CustomType` under this name. FFI modules don't, so they are left alone.
const DEFINES_CUSTOM_TYPES = "CustomType as $CustomType";
const CLASS = /^(?:export )?class (\w+) extends /gm;
const FOOTERS_WRITTEN = ".rays-rpc-footers";

/** What the footers register, besides every module's custom types. */
export interface Registered {
  methods: readonly RpcMethod[];
  classes: readonly DurableObjectClass[];
}

export async function writeFooters(
  context: RpcContext,
  { methods, classes }: Registered,
  ffi: string,
): Promise<void> {
  const byModule = new Map<
    string,
    { methods: RpcMethod[]; classes: DurableObjectClass[] }
  >();
  const of = (module: string) => {
    let found = byModule.get(module);
    if (found === undefined) {
      found = { methods: [], classes: [] };
      byModule.set(module, found);
    }
    return found;
  };
  for (const method of methods) of(method.module).methods.push(method);
  for (const object of classes) of(object.module).classes.push(object);

  // Footers are only written while the project has methods or classes. This
  // file says an earlier build wrote some, so a build without them only
  // reads every compiled module when there are footers to remove. It is
  // written before the footers, so a build that stops halfway leaves it
  // behind too.
  const wanted = methods.length > 0 || classes.length > 0;
  const marker = path.join(context.javascript, FOOTERS_WRITTEN);
  const written = await readFile(marker).then(
    () => true,
    () => false,
  );
  if (!wanted && !written) return;
  if (wanted && !written) {
    await writeFile(marker, "rays/worker_rpc footers are in this build.\n");
  }

  let packages: string[];
  try {
    packages = await readdir(context.javascript);
  } catch {
    return;
  }

  const none: Registered = { methods: [], classes: [] };
  for (const packageName of packages) {
    const directory = path.join(context.javascript, packageName);
    for (const file of await compiledFiles(directory)) {
      if (!file.endsWith(".mjs")) continue;
      const module = path
        .relative(directory, file)
        .slice(0, -".mjs".length)
        .split(path.sep)
        .join("/");
      const source = await readFile(file, "utf8");
      const body = stripFooter(source);
      const footer = wanted
        ? footerFor(
            body,
            module,
            packageName === context.packageName
              ? (byModule.get(module) ?? none)
              : none,
            relativeSpecifier(path.dirname(file), ffi),
          )
        : "";
      const updated = footer === "" ? body : `${body}${footer}`;
      if (updated !== source) await writeAtomically(file, updated);
    }
  }
  if (!wanted) await rm(marker, { force: true });
}

function footerFor(
  body: string,
  module: string,
  { methods, classes }: Registered,
  ffi: string,
): string {
  const types = body.includes(DEFINES_CUSTOM_TYPES)
    ? [...body.matchAll(CLASS)].map((match) => match[1]!)
    : [];
  if (types.length === 0 && methods.length === 0 && classes.length === 0) {
    return "";
  }

  const lines = [
    FOOTER_MARKER,
    "// Added by rays to register this module's custom types, RPC methods and",
    "// Durable Object classes for rays/worker_rpc. It is rewritten on every",
    "// build.",
    `import { register as $rays_register, registerMethod as $rays_register_method, registerClass as $rays_register_class } from ${JSON.stringify(ffi)};`,
  ];
  if (types.length > 0) {
    lines.push(
      `$rays_register(${JSON.stringify(module)}, { ${types.join(", ")} });`,
    );
  }
  for (const method of methods) {
    const identifier = exportedName(body, method.name);
    lines.push(
      `$rays_register_method(${JSON.stringify(module)}, ${JSON.stringify(method.name)}, ${identifier}, ${JSON.stringify(method.version)});`,
    );
  }
  for (const object of classes) {
    const identifier = exportedName(body, object.function);
    lines.push(
      `$rays_register_class(${JSON.stringify(object.className)}, ${identifier});`,
    );
  }
  return `\n${lines.join("\n")}\n`;
}

// The JavaScript name of a public Gleam function. Gleam adds a `$` to names
// that are reserved in JavaScript, such as `delete`. A function written in
// Gleam is an `export function`; an external one is imported, then listed in
// an `export { ... }`.
function exportedName(body: string, name: string): string {
  const listed = new Set(
    [...body.matchAll(/^export \{([^}]*)\};?$/gm)].flatMap((match) =>
      match[1]!.split(",").map((item) => item.trim()),
    ),
  );
  for (const candidate of [name, `${name}$`]) {
    if (listed.has(candidate)) return candidate;
    const escaped = candidate.replace(/\$/g, "\\$");
    if (new RegExp(`^export function ${escaped}\\(`, "m").test(body))
      return candidate;
  }
  throw new BuildError(`Could not find the compiled function ${name}.`);
}

/** The module source without the footer an earlier build appended. */
export function stripFooter(source: string): string {
  const at = source.indexOf(`\n${FOOTER_MARKER}\n`);
  return at === -1 ? source : source.slice(0, at);
}

async function compiledFiles(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        (entry.endsWith(".mjs") || entry.endsWith(".mts")) &&
        !entry.endsWith(".d.mts") &&
        !entry.split(path.sep).includes("_gleam_artefacts"),
    )
    .map((entry) => path.join(directory, entry));
}
