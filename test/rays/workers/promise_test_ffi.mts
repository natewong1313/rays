import { Result$isError, Result$Error$0 } from "../../gleam.mjs";
import { context, waitForBackground } from "./simulate_ffi.mts";
import { readBytes } from "../workers_ffi.mts";
import { run } from "./fetch_api_test_ffi.mts";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function rejectsWith(promise: Promise<unknown>, reason: unknown) {
  const [outcome] = await Promise.allSettled([promise]);
  check(outcome.status === "rejected", "Expected a native rejection");
  check(outcome.reason === reason, "The original rejection reason was lost");
}

function request(): Request {
  return new Request("https://example.com/");
}

export async function earlyBackgroundFailure(): Promise<undefined> {
  const failure = new Error("background failed before response");
  await rejectsWith(run({
    async fetch(_request, _env, ctx) {
      ctx.waitUntil(Promise.reject(failure));
      // An event-loop turn exposes late rejection handling to the runtime.
      await nextTurn();
      return new Response("ok");
    },
  }, request()), failure);
  return undefined;
}

export async function nestedBackgroundWork(): Promise<undefined> {
  let finished = false;
  const [, registered] = await run({
    async fetch(_request, _env, ctx) {
      ctx.waitUntil(nextTurn().then(() => {
        ctx.waitUntil(nextTurn().then(() => { finished = true; }));
      }));
      return new Response("ok");
    },
  }, request());
  check(registered === 2, "Both background tasks should be registered");
  check(finished, "The harness returned before nested background work finished");
  return undefined;
}

export async function backgroundFailureDrainsAll(): Promise<undefined> {
  const failure = new Error("background failed");
  let finished = false;
  await rejectsWith(run({
    async fetch(_request, _env, ctx) {
      ctx.waitUntil(Promise.reject(failure));
      ctx.waitUntil(nextTurn().then(() => {
        ctx.waitUntil(nextTurn().then(() => { finished = true; }));
      }));
      return new Response("ok");
    },
  }, request()), failure);
  check(finished, "Background failure should not abandon other tasks");
  return undefined;
}

export async function handlerFailureDrainsAll(): Promise<undefined> {
  for (const synchronous of [true, false]) {
    const failure = new Error("handler failed");
    let finished = false;
    await rejectsWith(run({
      fetch(_request, _env, ctx) {
        ctx.waitUntil(Promise.reject(new Error("background also failed")));
        ctx.waitUntil(nextTurn().then(() => { finished = true; }));
        if (synchronous) throw failure;
        return Promise.reject(failure);
      },
    }, request()), failure);
    check(finished, "Handler failure should not abandon background work");
  }
  return undefined;
}

export async function simulatedBackgroundFailure(): Promise<undefined> {
  const ctx = context();
  // `undefined` is a valid rejection reason and must not mean "no failure".
  ctx.waitUntil(Promise.reject(undefined));
  await nextTurn();
  const background = await waitForBackground(ctx);
  check(Result$isError(background),
    "Background failure should fulfill with Error");
  check(Result$Error$0(background) === undefined,
    "The original rejection reason was lost");
  const fresh = await waitForBackground(context());
  check(!Result$isError(fresh), "A fresh context has no failures");
  return undefined;
}

export async function unprintableBodyErrors(): Promise<undefined> {
  const throwingMessage = Object.defineProperty(new Error(), "message", {
    get() { throw new Error("cannot read message"); },
  });
  for (const reason of [Object.create(null), throwingMessage, {
    [Symbol.toPrimitive]() { throw new Error("cannot stringify"); },
  }]) {
    const body = new ReadableStream({
      start(controller) { controller.error(reason); },
    });
    const init = { method: "POST", body, duplex: "half" };
    const outcome = await readBytes(new Request("https://example.com/", init));
    check(Result$isError(outcome), "Body failure should fulfill with Error");
    check(Result$Error$0(outcome) === "Unknown body read error",
      "An unprintable failure should have a fallback message");
  }
  return undefined;
}

export async function synchronousBodyFailure(): Promise<undefined> {
  const req = request();
  req.arrayBuffer = () => { throw new Error("body read threw"); };
  const outcome = await readBytes(req);
  check(Result$isError(outcome), "A synchronous throw should fulfill with Error");
  check(Result$Error$0(outcome) === "body read threw", "The message was lost");
  return undefined;
}
