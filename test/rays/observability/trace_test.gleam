//// Tests for `rays/observability/trace`, and for the tracing `rays/worker` does on its
//// own, against a fake of the runtime's tracing API that records spans.

import gleam/dynamic.{type Dynamic}
import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}
import gleam/list
import rays/observability/trace
import rays/worker.{type Handler}

/// A span the fake recorded. Attribute values are written as
/// `"<JavaScript type>:<value>"`, such as `"number:42"`.
type Recorded {
  Recorded(
    name: String,
    parent: String,
    attributes: List(#(String, String)),
    status: String,
    exceptions: List(String),
    ended: Bool,
  )
}

/// Run `run` with the fake tracer installed, until it returns or, if it
/// returns a promise, until the promise settles. The fake is removed even if
/// `run` fails, so a failing test can't leave it to the next.
@external(javascript, "./trace_test_ffi.mts", "traced")
fn traced(run: fn() -> a) -> a

@external(javascript, "./trace_test_ffi.mts", "recorded")
fn js_recorded() -> Array(
  #(String, String, Array(#(String, String)), String, Array(String), Bool),
)

/// The spans recorded since ``traced` started, without the request's root span.
fn recorded() -> List(Recorded) {
  let assert [_root, ..spans] = all_recorded()
  spans
}

/// The spans recorded since ``traced` started, starting with the request's root
/// span, named `fetch` until something renames it.
fn all_recorded() -> List(Recorded) {
  js_recorded()
  |> array.to_list
  |> list.map(fn(span) {
    let #(name, parent, attributes, status, exceptions, ended) = span
    Recorded(
      name:,
      parent:,
      attributes: array.to_list(attributes),
      status:,
      exceptions: array.to_list(exceptions),
      ended:,
    )
  })
}

// Without tracing

pub fn span_runs_without_tracing_test() {
  assert trace.span("work", [#("a", trace.int(1))], fn() { 42 }) == 42
}

pub fn spans_are_placeholders_without_tracing_test() {
  let span =
    trace.current()
    |> trace.set_attributes([#("a", trace.string("b"))])
    |> trace.set_status(trace.Failed("ignored"))
    |> trace.rename("ignored")
  assert trace.trace_id(span) == Error(Nil)
}

pub fn try_runs_without_tracing_test() {
  use result <- promise.map(
    trace.try("work", [], describe: fn(error) { error }, run: fn() {
      promise.resolve(Error("nope"))
    }),
  )
  assert result == Error("nope")
}

// Spans

pub fn span_records_name_and_attributes_test() {
  let spans =
    traced(fn() {
      trace.span(
        "load_user",
        [
          #("user.id", trace.string("42")),
          #("post.count", trace.int(3)),
          #("score", trace.float(0.5)),
          #("admin", trace.bool(True)),
        ],
        fn() { Nil },
      )
      recorded()
    })
  let assert [span] = spans
  assert span.name == "load_user"
  assert span.parent == "fetch"
  assert span.attributes
    == [
      #("user.id", "string:42"),
      #("post.count", "number:3"),
      #("score", "number:0.5"),
      #("admin", "boolean:true"),
    ]
  assert span.status == "unset"
  assert span.ended
}

pub fn spans_nest_test() {
  let spans =
    traced(fn() {
      use <- trace.span("outer", [])
      use <- trace.span("inner", [])
      recorded()
    })
  let assert [outer, inner] = spans
  assert outer.parent == "fetch"
  assert inner.parent == "outer"
}

pub fn span_returns_result_of_run_test() {
  let value = traced(fn() { trace.span("work", [], fn() { "done" }) })
  assert value == "done"
}

pub fn span_ends_when_promise_settles_test() {
  use spans <- promise.map(
    traced(fn() {
      use <- trace.span("wait", [])
      use _ <- promise.map(promise.wait(1))
      // Still running, so the span is still open.
      let assert [wait] = recorded()
      assert !wait.ended
      Nil
    })
    |> promise.map(fn(_) { recorded() }),
  )
  let assert [wait] = spans
  assert wait.ended
}

pub fn span_with_gives_the_span_test() {
  let spans =
    traced(fn() {
      use span <- trace.span_with("load_posts", [])
      trace.set_attributes(span, [#("post.count", trace.int(2))])
      recorded()
    })
  let assert [span] = spans
  assert span.attributes == [#("post.count", "number:2")]
}

pub fn current_is_innermost_span_test() {
  let spans =
    traced(fn() {
      use <- trace.span("inner", [])
      trace.current() |> trace.set_attributes([#("here", trace.bool(True))])
      recorded()
    })
  let assert [span] = spans
  assert span.attributes == [#("here", "boolean:true")]
}

pub fn current_is_root_outside_spans_test() {
  let spans =
    traced(fn() {
      trace.current() |> trace.rename("GET /")
      all_recorded()
    })
  let assert [root] = spans
  assert root.name == "GET /"
}

pub fn later_attributes_replace_earlier_test() {
  let spans =
    traced(fn() {
      use span <- trace.span_with("work", [#("a", trace.int(1))])
      trace.set_attributes(span, [#("a", trace.int(2))])
      recorded()
    })
  let assert [span] = spans
  assert span.attributes == [#("a", "number:2")]
}

pub fn set_status_test() {
  let spans =
    traced(fn() {
      trace.span_with("failed", [], fn(span) {
        trace.set_status(span, trace.Failed("Card declined"))
      })
      trace.span_with("succeeded", [], fn(span) {
        trace.set_status(span, trace.Succeeded)
      })
      recorded()
    })
  let assert [failed, succeeded] = spans
  assert failed.status == "error: Card declined"
  assert succeeded.status == "ok"
}

pub fn rename_test() {
  let spans =
    traced(fn() {
      trace.span_with("first", [], fn(span) { trace.rename(span, "second") })
      recorded()
    })
  let assert [span] = spans
  assert span.name == "second"
}

pub fn trace_id_test() {
  let id = traced(fn() { trace.trace_id(trace.current()) })
  assert id == Ok("4bf92f3577b34da6a3ce929d0e0e4736")
}

// try

pub fn try_ok_succeeds_test() {
  use spans <- promise.map(
    traced(fn() {
      use result <- promise.map(
        trace.try("charge", [], describe: fn(error) { error }, run: fn() {
          promise.resolve(Ok(1))
        }),
      )
      assert result == Ok(1)
      recorded()
    }),
  )
  let assert [span] = spans
  assert span.status == "ok"
}

pub fn try_error_fails_with_description_test() {
  use spans <- promise.map(
    traced(fn() {
      use result <- promise.map({
        use <- trace.try("charge", [], describe: fn(error) {
          "Declined: " <> error
        })
        promise.resolve(Error("insufficient funds"))
      })
      assert result == Error("insufficient funds")
      recorded()
    }),
  )
  let assert [span] = spans
  assert span.status == "error: Declined: insufficient funds"
}

// rays/worker's request span

type JsRequest

type JsResponse

@external(javascript, "../worker/fetch_api_test_ffi.mts", "request")
fn js_request(
  method: String,
  url: String,
  headers: Array(#(String, String)),
) -> JsRequest

@external(javascript, "../worker/fetch_api_test_ffi.mts", "run")
fn js_run(
  worker: worker.Worker,
  request: JsRequest,
) -> Promise(#(JsResponse, Int, Bool))

/// Send a GET request to a Worker, and return the root span it recorded.
fn root_span(handler: Handler, path: String) -> Promise(Recorded) {
  let request =
    js_request("GET", "https://example.com" <> path, array.from_list([]))
  use spans <- promise.map(
    traced(fn() {
      js_run(worker.new(handler), request)
      |> promise.map(fn(_) { all_recorded() })
    }),
  )
  let assert [root, ..] = spans
  root
}

fn respond(status: Int) -> Handler {
  fn(_, _, _) { promise.resolve(worker.response(status)) }
}

pub fn request_span_is_named_after_route_test() {
  use root <- promise.map(root_span(respond(200), "/users/42/posts"))
  assert root.name == "GET /users/:id/posts"
}

pub fn request_span_records_status_test() {
  use root <- promise.map(root_span(respond(404), "/"))
  assert root.attributes == [#("http.response.status_code", "number:404")]
  // A client error isn't the server's failure.
  assert root.status == "unset"
}

pub fn server_error_fails_request_span_test() {
  use root <- promise.map(root_span(respond(503), "/"))
  assert root.status == "error: Responded with 503"
}

pub fn panic_is_recorded_on_request_span_test() {
  let request = js_request("GET", "https://example.com/", array.from_list([]))
  let handler = fn(_, _, _) { panic as "the handler crashed" }
  use spans <- promise.map(
    traced(fn() {
      js_run(worker.new(handler), request)
      |> promise.map(fn(_) { Error(Nil) })
      |> promise.rescue(fn(error: Dynamic) { Ok(error) })
      |> promise.map(fn(thrown) {
        // The panic still reaches the runtime.
        let assert Ok(_) = thrown
        all_recorded()
      })
    }),
  )
  let assert [root, ..] = spans
  assert root.exceptions == ["the handler crashed"]
  assert root.status == "error: the handler crashed"
  let assert Ok("string:panic") = list.key_find(root.attributes, "gleam.error")
  let assert Ok(
    "string:rays/observability/trace_test.panic_is_recorded_on_request_span_test",
  ) = list.key_find(root.attributes, "code.function.name")
  let assert Ok("string:" <> _) =
    list.key_find(root.attributes, "code.file.path")
  let assert Ok("number:" <> _) =
    list.key_find(root.attributes, "code.line.number")
}
