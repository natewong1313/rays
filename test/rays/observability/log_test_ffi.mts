// Helpers for `log_test`: capturing what is written to the `console`.

import { toList } from "../../gleam.mjs";

const methods = ["debug", "info", "warn", "error", "log"] as const;

// Run `run` with the `console` methods replaced, then restore them. Returns
// each call as the method name and its arguments as a JSON array.
export function captureConsole(run: () => unknown) {
  const calls: [string, string][] = [];
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      calls.push([method, JSON.stringify(args)]);
    };
  }
  try {
    run();
  } finally {
    methods.forEach((method, index) => (console[method] = originals[index]));
  }
  return toList(calls);
}
