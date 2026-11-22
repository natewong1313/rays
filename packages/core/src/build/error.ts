/** A build failure with a message meant for the developer. */
export class BuildError extends Error {
  override name = "BuildError";

  /** What Gleam printed, if the failure came from Gleam. */
  readonly output: string;

  constructor(message: string, output = "") {
    super(message);
    this.output = output;
  }
}
