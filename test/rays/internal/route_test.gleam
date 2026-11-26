//// Tests for `rays/internal/route`: which path segments are taken for IDs.

import gleam/http
import gleam/http/request
import rays/internal/route

fn name_of(path: String) -> String {
  let assert Ok(request) = request.to("https://example.com" <> path)
  route.span_name(request)
}

pub fn keeps_fixed_segments_test() {
  assert name_of("/") == "GET /"
  assert name_of("/users") == "GET /users"
  assert name_of("/posts/hello-world") == "GET /posts/hello-world"
  assert name_of("/api/v2/status") == "GET /api/v2/status"
  // Long, but without a digit, so more likely a slug than a key.
  assert name_of("/posts/a-very-long-post-title")
    == "GET /posts/a-very-long-post-title"
}

pub fn replaces_ids_test() {
  assert name_of("/users/42") == "GET /users/:id"
  assert name_of("/orders/3f2a9c1e-7b4d-4e8a-9c1f-2d5e6b7a8b7d/items")
    == "GET /orders/:id/items"
  assert name_of("/files/9f86d081884c7d65") == "GET /files/:id"
  assert name_of("/invites/V1StGXR8Z5jdHi6BmyT3q") == "GET /invites/:id"
}

pub fn short_tokens_with_digits_are_kept_test() {
  // 15 characters, one short of a token, then 16.
  assert name_of("/builds/release-2026-12") == "GET /builds/release-2026-12"
  assert name_of("/builds/release-2026-123") == "GET /builds/:id"
}

pub fn uses_method_test() {
  let assert Ok(request) = request.to("https://example.com/users/7")
  assert route.span_name(request.set_method(request, http.Post))
    == "POST /users/:id"
}
