// FFI shim for `rays/observability/log`: writing logs with the `console` methods, which the
// Workers runtime sends to Workers Logs and `wrangler tail`, and holding the
// minimum level.
//
// Levels and their ranks are decided in Gleam; these functions only call the
// method and store the number.

type Method = "debug" | "info" | "warn" | "error";

// The rank of the least severe level written, shared by the whole isolate.
// 0 is `Debug`, so everything is written until `set_level` is called.
let minimum = 0;

export function setMinimumRank(rank: number): undefined {
  minimum = rank;
}

export function minimumRank(): number {
  return minimum;
}

export function writeText(method: Method, message: string): undefined {
  console[method](message);
}

// Logged as an object rather than the JSON string, so `wrangler dev` prints
// it as an object. Workers Logs indexes its fields either way.
export function writeJson(method: Method, json: string): undefined {
  console[method](JSON.parse(json));
}
