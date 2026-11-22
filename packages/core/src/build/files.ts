// File helpers shared by the build steps.

import { randomUUID } from "node:crypto";
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
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
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
