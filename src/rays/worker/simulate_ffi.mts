// FFI shim for `rays/worker/simulate`: stand-in requests, `env`, and `ctx`.
//
// Only the body of a simulated `Request` is read by `rays/worker`; its method,
// URL, and headers come from the Gleam request record. The placeholder URL and
// `POST` method exist because the Fetch API requires a URL and forbids a body
// on `GET` requests.

import { Result$Error, Result$Ok } from "../../gleam.mjs";
import type { BitArray, Result } from "../../gleam.mjs";
import { toUint8Array } from "../worker_ffi.mts";
import type { Env, Worker } from "../worker_ffi.mts";
import { simulatedService } from "../worker_rpc_ffi.mts";

const PLACEHOLDER_URL = "https://simulate.invalid/";

export function emptyRequest(): Request {
  return new Request(PLACEHOLDER_URL);
}

export function textRequest(body: string): Request {
  return new Request(PLACEHOLDER_URL, { method: "POST", body });
}

export function bytesRequest(body: BitArray): Request {
  return new Request(PLACEHOLDER_URL, {
    method: "POST",
    body: toUint8Array(body),
  });
}

export function emptyEnv(): Env {
  return {};
}

export function envWith(env: Env, name: string, value: unknown): Env {
  return { ...env, [name]: value };
}

// The runtime type has members such as `props` that a simulated context
// does not implement; a `rays` Worker only uses `waitUntil` and
// `passThroughOnException`.
function asRuntimeContext(ctx: SimulatedContext): ExecutionContext {
  return ctx as unknown as ExecutionContext;
}

// A stand-in for a service binding: requests sent to it are handled by the
// given Worker, with no bindings and the caller's context, mirroring how the
// runtime ties a bound Worker's `waitUntil` to the caller's request. The
// request is what `rays/fetch` sends, so it has no incoming `cf` properties;
// `rays` handlers only read those through `cf_properties`, which tolerates
// that.
export function envWithService(
  env: Env,
  name: string,
  worker: Worker,
  ctx: SimulatedContext,
): Env {
  const service = {
    fetch: async (request: Request): Promise<Response> =>
      worker.fetch!(
        request as Parameters<NonNullable<Worker["fetch"]>>[0],
        {},
        asRuntimeContext(ctx),
      ),
  };
  return envWith(env, name, service);
}

// A stand-in for a service binding to a Worker with RPC methods. See
// `simulatedService` in `rays/worker_rpc`'s FFI.
export function envWithRpcService(
  env: Env,
  name: string,
  worker: Worker,
  workerEnv: Env,
  ctx: SimulatedContext,
): Env {
  return envWith(
    env,
    name,
    simulatedService(worker, workerEnv, asRuntimeContext(ctx)),
  );
}

// Only the members `rays/worker` uses.
export type SimulatedContext = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException"
> & {
  readonly waited: number;
  readonly passedThrough: boolean;
  waitForBackground(): Promise<undefined>;
};

export function context(): SimulatedContext {
  const waited: Promise<void>[] = [];
  let failure: { reason: unknown } | undefined;
  let passedThrough = false;
  return {
    waitUntil(promise) {
      // Observe rejection immediately, even if the handler is still running.
      waited.push(
        promise.then(
          () => {},
          (reason) => {
            failure ??= { reason };
          },
        ),
      );
    },
    passThroughOnException() {
      passedThrough = true;
    },
    get waited() {
      return waited.length;
    },
    get passedThrough() {
      return passedThrough;
    },
    async waitForBackground() {
      let drained = 0;
      while (drained < waited.length) {
        const batch = waited.slice(drained);
        drained = waited.length;
        // These promises cannot reject, so every task gets to finish.
        await Promise.all(batch);
      }
      if (failure !== undefined) throw failure.reason;
      return undefined;
    },
  };
}

// Fulfills with the first observed native rejection; never rejects itself.
export async function waitForBackground(
  ctx: SimulatedContext,
): Promise<Result<undefined, unknown>> {
  try {
    await ctx.waitForBackground();
  } catch (reason) {
    return Result$Error(reason);
  }
  return Result$Ok(undefined);
}
