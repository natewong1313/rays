// FFI shim for `rays/log`: writing logs with the `console` methods, which the
// Workers runtime sends to Workers Logs and `wrangler tail`.
//
// The level is chosen in Gleam; these functions only call the method.

type Method = "debug" | "info" | "warn" | "error";

export function writeText(method: Method, message: string): undefined {
  console[method](message);
}

// Logged as an object rather than the JSON string, so `wrangler dev` prints
// it as an object. Workers Logs indexes its fields either way.
export function writeJson(method: Method, json: string): undefined {
  console[method](JSON.parse(json));
}
