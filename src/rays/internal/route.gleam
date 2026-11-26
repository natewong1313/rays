//// Guessing a request's route from its path, to name the span Cloudflare
//// records for the request. rays has no router, so it can't see the
//// patterns a handler matches: instead, segments that look like IDs become
//// `:id`, so requests to the same route share a name as long as the parts
//// that vary are IDs.

import gleam/http
import gleam/http/request.{type Request}
import gleam/list
import gleam/string

/// The name of a request's span: its method and its guessed route, such as
/// `GET /users/:id/posts` for `GET /users/42/posts`.
///
pub fn span_name(request: Request(body)) -> String {
  let route =
    request.path_segments(request)
    |> list.map(fn(segment) {
      case looks_like_id(segment) {
        True -> ":id"
        False -> segment
      }
    })
    |> string.join("/")
  string.uppercase(http.method_to_string(request.method)) <> " /" <> route
}

/// The shortest token, such as a UUID, a hex hash, or a random key, that is
/// taken for an ID. Shorter segments with digits, such as `v2`, are more
/// often fixed parts of a route.
///
const min_token_length = 16

const digits = "0123456789"

const url_safe =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"

/// Whether a path segment is most likely an ID rather than a fixed part of a
/// route: a number, or a long URL-safe token with a digit in it. A slug such
/// as `hello-world` has no digits, so it is kept.
///
fn looks_like_id(segment: String) -> Bool {
  let characters = string.to_graphemes(segment)
  case characters {
    [] -> False
    _ ->
      list.all(characters, string.contains(digits, _))
      || list.length(characters) >= min_token_length
      && list.all(characters, string.contains(url_safe, _))
      && list.any(characters, string.contains(digits, _))
  }
}
