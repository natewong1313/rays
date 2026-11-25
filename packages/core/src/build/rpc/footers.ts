// The footers appended to compiled modules, which register their custom
// types and RPC methods with rays/worker_rpc's FFI.

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { relativeSpecifier, writeAtomically } from "../files.ts";
import { RpcBuildError, type RpcContext, type RpcMethod } from "./types.ts";

/** The first line of a footer, which marks where it starts. */
export const FOOTER_MARKER = "// rays:rpc";

// A compiled Gleam module that defines a custom type imports the prelude's
// `CustomType` under this name. FFI modules don't, so they are left alone.
const DEFINES_CUSTOM_TYPES = "CustomType as $CustomType";
const CLASS = /^(?:export )?class (\w+) extends /gm;
const FOOTERS_WRITTEN = ".rays-rpc-footers";

export async function writeFooters(
  context: RpcContext,
  methods: RpcMethod[],
  ffi: string,
): Promise<void> {
  const byModule = new Map<string, RpcMethod[]>();
  for (const method of methods) {
    byModule.set(method.module, [
      ...(byModule.get(method.module) ?? []),
      method,
    ]);
  }

  // Footers are only written while the project has methods. This file says
  // an earlier build wrote some, so a build without methods only reads every
  // compiled module when there are footers to remove. It is written before
  // the footers, so a build that stops halfway leaves it behind too.
  const marker = path.join(context.javascript, FOOTERS_WRITTEN);
  const written = await readFile(marker).then(
    () => true,
    () => false,
  );
  if (methods.length === 0 && !written) return;
  if (methods.length > 0 && !written) {
    await writeFile(marker, "rays/worker_rpc footers are in this build.\n");
  }

  let packages: string[];
  try {
    packages = await readdir(context.javascript);
  } catch {
    return;
  }

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
      const footer =
        methods.length === 0
          ? ""
          : footerFor(
              body,
              module,
              packageName === context.packageName
                ? (byModule.get(module) ?? [])
                : [],
              relativeSpecifier(path.dirname(file), ffi),
            );
      const updated = footer === "" ? body : `${body}${footer}`;
      if (updated !== source) await writeAtomically(file, updated);
    }
  }
  if (methods.length === 0) await rm(marker, { force: true });
}

function footerFor(
  body: string,
  module: string,
  methods: RpcMethod[],
  ffi: string,
): string {
  const classes = body.includes(DEFINES_CUSTOM_TYPES)
    ? [...body.matchAll(CLASS)].map((match) => match[1]!)
    : [];
  if (classes.length === 0 && methods.length === 0) return "";

  const lines = [
    FOOTER_MARKER,
    "// Added by rays to register this module's custom types and RPC methods",
    "// for rays/worker_rpc. It is rewritten on every build.",
    `import { register as $rays_register, registerMethod as $rays_register_method } from ${JSON.stringify(ffi)};`,
  ];
  if (classes.length > 0) {
    lines.push(
      `$rays_register(${JSON.stringify(module)}, { ${classes.join(", ")} });`,
    );
  }
  for (const method of methods) {
    const identifier = exportedName(body, method.name);
    lines.push(
      `$rays_register_method(${JSON.stringify(module)}, ${JSON.stringify(method.name)}, ${identifier}, ${JSON.stringify(method.version)});`,
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
  throw new RpcBuildError(`Could not find the compiled function ${name}.`);
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
