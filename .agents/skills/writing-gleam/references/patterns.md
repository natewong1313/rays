# Gleam patterns

Read the section relevant to the type or API being changed. Excerpts come from the supplied repository studies; adaptations are identified. Imports and supporting declarations have been added where needed to make each block a complete module.

## Labelled functions: stdlib

The studied `gleam/result` implementation makes the transformed value first and names the callback's role:

```gleam
pub fn map(over result: Result(a, e), with fun: fn(a) -> b) -> Result(b, e) {
  case result {
    Ok(x) -> Ok(fun(x))
    Error(e) -> Error(e)
  }
}
```

Calls can read `map(over: value, with: transform)` or `value |> map(with: transform)`. Labels form part of the public contract.

## Fallible sequencing: gleam_http

This `from_uri` excerpt converts optional stored URI data into fallible operations, then constructs a typed request on the success path:

```gleam
import gleam/http.{Get}
import gleam/http/request.{type Request, Request}
import gleam/option
import gleam/result
import gleam/uri.{type Uri}

pub fn from_uri(uri: Uri) -> Result(Request(String), Nil) {
  use scheme <- result.try(
    uri.scheme |> option.unwrap("") |> http.scheme_from_string,
  )
  use host <- result.try(uri.host |> option.to_result(Nil))
  let req =
    Request(
      method: Get,
      headers: [],
      body: "",
      scheme:,
      host:,
      port: uri.port,
      path: uri.path,
      query: uri.query,
    )
  Ok(req)
}
```

The error types of chained steps must agree. Map a lower-level error to the domain error before chaining when they differ.

## Normalizing immutable setters: gleam_http

The studied setter preserves the payload parameter and normalizes the header name at the operation that promises the invariant:

```gleam
import gleam/http/request.{type Request, Request}
import gleam/list
import gleam/string

pub fn set_header(
  request: Request(body),
  key: String,
  value: String,
) -> Request(body) {
  let headers = list.key_set(request.headers, string.lowercase(key), value)
  Request(..request, headers:)
}
```

Wisp specializes generic HTTP types with domain aliases such as `pub type Response = HttpResponse(Body)`. Use an alias when the representation already fits; use a new type when construction needs a separate contract.

## Shared structure: glance

The studied AST shares attribute-bearing structure through a payload parameter. The `Span` declaration gives a pair of positions a domain name:

```gleam
pub type Definition(definition) {
  Definition(attributes: List(Attribute), definition: definition)
}

pub type Attribute {
  Attribute(name: String)
}

/// A span within a file, indicated by byte offsets.
pub type Span {
  Span(start: Int, end: Int)
}
```

`Attribute` above is simplified supporting data. A private alias such as `type Tokens = List(#(Token, Position))` is useful local vocabulary without enlarging the public API.

## Configuration: glint

Adapted to a minimal complete configuration module from glint's nested record updates and single default definition:

```gleam
type Config {
  Config(indent_width: Int, exit: Bool)
}

const default_config = Config(indent_width: 4, exit: True)

pub opaque type Cli(a) {
  Cli(config: Config, flags: List(a))
}

pub fn new(flags: List(a)) -> Cli(a) {
  Cli(config: default_config, flags:)
}

/// Set the help indentation width. Default: 4.
pub fn with_indent_width(cli: Cli(a), indent_width: Int) -> Cli(a) {
  Cli(..cli, config: Config(..cli.config, indent_width:))
}

/// Return control to the caller after parsing. Default: exit enabled.
pub fn without_exit(cli: Cli(a)) -> Cli(a) {
  Cli(..cli, config: Config(..cli.config, exit: False))
}
```

This demonstrates update syntax, not a requirement that every config setting be infallible. Check user input when a setting has a restricted domain.

## Protected construction: mist's opacity pattern

Adaptation: a port can only be obtained after its range is checked. Its numeric representation remains private to the module:

```gleam
import gleam/int
import gleam/result

pub opaque type Port {
  Port(value: Int)
}

/// Parse a port in the inclusive range 1 to 65535.
pub fn parse(input: String) -> Result(Port, Nil) {
  use value <- result.try(int.parse(input))
  case value >= 1 && value <= 65_535 {
    True -> Ok(Port(value:))
    False -> Error(Nil)
  }
}

pub fn to_int(port: Port) -> Int {
  port.value
}
```

The range is this example's domain choice. Mist applies opacity to `Next(state, user_message)` and exposes functions such as `continue` and `stop`, protecting construction of protocol transitions.

## Error layers: birdie, squirrel, simplifile, and snag

Adaptation of birdie's domain wrapping over simplifile's filesystem taxonomy. The small `FileError` here stands in for the underlying library type:

```gleam
pub type FileError {
  Eacces
  Enoent
  Unknown(inner: String)
}

pub type SnapshotError {
  /// A snapshot title was empty.
  SnapshotWithEmptyTitle
  /// Writing a snapshot failed at the filesystem boundary.
  CannotSaveNewSnapshot(reason: FileError, title: String, destination: String)
}

pub fn save_error(
  reason: FileError,
  title: String,
  destination: String,
) -> SnapshotError {
  CannotSaveNewSnapshot(reason:, title:, destination:)
}
```

Preserve source taxonomy when it helps callers, as simplifile does with POSIX names. A rendering function can exhaustively match the domain variants and use their context. Squirrel uses this structured approach even though it is a CLI.

Snag instead targets an outer layer that only needs success or a contextual report. Its studied immutable context operation is:

```gleam
pub type Snag {
  Snag(issue: String, cause: List(String))
}

pub fn layer(snag: Snag, issue: String) -> Snag {
  Snag(issue: issue, cause: [snag.issue, ..snag.cause])
}
```

Choose the representation from the consumer's needs; the package being a CLI or a library is only a clue. Preserve structured causes until the reporting boundary.
