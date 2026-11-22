// Checking the modules a build is asked to make Workers from.

import { BuildError } from "./error.ts";
import { isModuleName, notAModuleName } from "./module-name.ts";
import { describeType, type ModuleInterface } from "./package-interface.ts";

export function checkModuleName(module: string): void {
  if (!isModuleName(module)) throw new BuildError(notAModuleName(module));
}

// Check that a module has `pub fn main() -> workers.Worker`, using the types
// Gleam reports, so mistakes show up here rather than when the Worker runs.
export function checkWorkerModule(
  module: string,
  moduleInterface: ModuleInterface | undefined,
): void {
  const source = `src/${module}.gleam`;
  if (moduleInterface === undefined) {
    throw new BuildError(
      `There is no Gleam module "${module}": ${source} does not exist.`,
    );
  }

  const main = moduleInterface.functions["main"];
  if (main === undefined) {
    throw new BuildError(
      `${source} has no public main function. Add \`pub fn main() -> workers.Worker\` that returns workers.new(...).`,
    );
  }
  if (main.parameters.length > 0) {
    throw new BuildError(`main in ${source} must take no arguments.`);
  }

  const returned = main.return;
  if (
    returned.kind !== "named" ||
    returned.package !== "rays" ||
    returned.module !== "rays/workers" ||
    returned.name !== "Worker"
  ) {
    throw new BuildError(
      `main in ${source} must return a workers.Worker, but it returns ${describeType(returned)}.`,
    );
  }
  if (!main.implementations["can-run-on-javascript"]) {
    throw new BuildError(`main in ${source} can't run on JavaScript.`);
  }
}
