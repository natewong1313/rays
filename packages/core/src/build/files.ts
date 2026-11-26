// File helpers shared by the build steps.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** An import specifier for `file`, relative to the directory `from`. */
export function relativeSpecifier(from: string, file: string): string {
  const specifier = path.relative(from, file).split(path.sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

/**
 * Write a file through a temporary one, so a watcher never sees half of it.
 * The temporary file's name is unique, as two builds can run at once, such
 * as one per Vite environment.
 */
export async function writeAtomically(
  file: string,
  contents: string,
): Promise<void> {
  const temporary = temporaryName(file);
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

/** {@link writeAtomically}, synchronously, making the file's directory. */
export function writeAtomicallySync(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = temporaryName(file);
  writeFileSync(temporary, contents);
  renameSync(temporary, file);
}

function temporaryName(file: string): string {
  return `${file}.${process.pid}.${randomUUID()}.tmp`;
}

/** The file's contents, or `undefined` if it doesn't exist. */
export function readIfExistsSync(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Write a file atomically, unless it already has `contents`, so a watcher
 * doesn't rebuild for nothing.
 *
 * @returns Whether the file was written.
 */
export async function writeIfChanged(
  file: string,
  contents: string,
): Promise<boolean> {
  try {
    if ((await readFile(file, "utf8")) === contents) return false;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomically(file, contents);
  return true;
}

export function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}
