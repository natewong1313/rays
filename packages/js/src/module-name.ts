// Gleam module names, such as "app" or "app/admin": lowercase path segments.
// No dependencies, so `cloudflare.config.ts` can load it.

/** Whether `name` is a Gleam module name. */
export function isModuleName(name: string): boolean {
  return /^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)*$/.test(name);
}

/** The explanation for a name that isn't a Gleam module name. */
export function notAModuleName(name: string): string {
  return `"${name}" is not a Gleam module name. Module names look like "app" or "app/admin".`;
}
