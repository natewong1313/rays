// Resets the instance, as a crash in a handler would, before the handler
// has waited on anything.
export function reset(ctx: DurableObjectState): undefined {
  ctx.abort("the handler reset the instance");
}
