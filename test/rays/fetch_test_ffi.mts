// Helpers for `fetch_test`: streams, and a stand-in for the global `fetch`.

// A stream containing the given text.
export function streamOf(text: string): ReadableStream {
  return new Response(text).body!;
}

export function streamText(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

// How the stand-in for the global `fetch` behaves.
type Behaviour = "echo_url" | "type_error" | "other_error" | "sync_throw";

// Replace the global `fetch` while `run` is pending, then restore it.
export async function withStubbedFetch<T>(
  behaviour: Behaviour,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((request: Request) => {
    switch (behaviour) {
      case "echo_url":
        return Promise.resolve(
          new Response(`${request.method} ${request.url}`),
        );
      case "type_error":
        return Promise.reject(new TypeError("fetch failed"));
      case "other_error":
        return Promise.reject(new RangeError("something else"));
      case "sync_throw":
        throw new TypeError("thrown synchronously");
    }
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
