//// Tests for the values `simulate` builds and reads.

import gleam/http
import gleam/http/request
import gleam/http/response
import gleam/javascript/promise
import gleam/option.{None, Some}
import rays/workers
import rays/workers/simulate

pub fn request_test() {
  let request = simulate.request(http.Delete, "/users/1?force=true")
  assert request.method == http.Delete
  assert request.scheme == http.Https
  assert request.host == "example.com"
  assert request.path == "/users/1"
  assert request.query == Some("force=true")
  assert simulate.request(http.Get, "/").query == None
}

pub fn html_body_test() {
  let request = simulate.request(http.Post, "/") |> simulate.html_body("<p>")
  assert request.get_header(request, "content-type")
    == Ok("text/html; charset=utf-8")
  use body <- promise.map(workers.read_body_string(request))
  assert body == Ok("<p>")
}

pub fn form_body_test() {
  let request =
    simulate.request(http.Post, "/") |> simulate.form_body([#("a b", "c&d")])
  assert request.get_header(request, "content-type")
    == Ok("application/x-www-form-urlencoded")
  use body <- promise.map(workers.read_body_string(request))
  assert body == Ok("a%20b=c%26d")
}

pub fn read_body_test() {
  assert simulate.read_body(workers.ok()) == "OK"
  assert simulate.read_body(workers.ok() |> workers.bit_array_body(<<"hi">>))
    == "hi"
  assert simulate.read_body(workers.no_content()) == ""
}

pub fn read_body_bits_test() {
  assert simulate.read_body_bits(workers.ok()) == <<"OK">>
  assert simulate.read_body_bits(workers.ok() |> workers.bit_array_body(<<1>>))
    == <<1>>
  assert simulate.read_body_bits(workers.no_content()) == <<>>
}

pub fn context_tracks_background_work_test() {
  let ctx = simulate.context()
  workers.wait_until(ctx, promise.resolve(Nil))
  workers.pass_through_on_exception(ctx)
  use result <- promise.map(simulate.wait_for_background(ctx))
  assert result == Ok(Nil)
}

pub fn context_treats_fulfilled_errors_as_values_test() {
  let ctx = simulate.context()
  workers.wait_until(ctx, promise.resolve(Error("expected failure")))
  use result <- promise.map(simulate.wait_for_background(ctx))
  assert result == Ok(Nil)
}

pub fn response_header_helpers_test() {
  let response =
    workers.response(200)
    |> workers.set_header("x-a", "1")
    |> workers.set_body(workers.Text("body"))
  assert response.get_header(response, "x-a") == Ok("1")
  assert simulate.read_body(response) == "body"
}
