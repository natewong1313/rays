//// Query the SQLite database of a
//// [Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
//// instance.
////
//// Each instance has its own database. Unlike its memory, the database
//// outlives an eviction, so it holds what the instance must not lose. It
//// runs in the same process as the instance, so a query is a function call
//// rather than a request: every function here but `delete_all` is
//// synchronous, and returns a `Result` rather than a `Promise`.
////
//// A class creates its tables with migrations, which `apply_migrations`
//// runs, here when an instance wakes, and its methods query them with
//// `query`:
////
//// ```gleam
//// // src/app/notes.gleam, with its migrations in src/app/notes/migrations/
//// import gleam/dynamic/decode
//// import gleam/javascript/promise.{type Promise}
//// import gleam/list
//// import gleam/result
//// import rays/durable_object.{type DurableObject, type Params}
//// import rays/durable_object/sql
////
//// pub fn notes() -> DurableObject(Nil) {
////   durable_object.new(Nil)
////   |> durable_object.on_wake(fn(wake) {
////     let assert Ok(_) = sql.apply_migrations(wake.context)
////     Nil
////   })
////   |> durable_object.bind(add)
////   |> durable_object.bind(recent)
//// }
////
//// pub fn add(params: Params(String, Nil)) -> Promise(Result(Int, Nil)) {
////   sql.query(
////     "insert into notes (body) values (?) returning id",
////     on: params.context,
////     with: [sql.text(params.args)],
////     expecting: decode.field(0, decode.int, decode.success),
////   )
////   |> result.replace_error(Nil)
////   |> result.try(list.first)
////   |> promise.resolve
//// }
////
//// pub fn recent(params: Params(Int, Nil)) -> Promise(List(String)) {
////   sql.query(
////     "select body from notes order by id desc limit ?",
////     on: params.context,
////     with: [sql.int(params.args)],
////     expecting: decode.field(0, decode.string, decode.success),
////   )
////   |> result.unwrap([])
////   |> promise.resolve
//// }
//// ```
////
//// The `packages/integration-tests` project in the rays repository runs
//// this class in the Workers runtime, with its migrations in `.sql` files.
////
//// ## Migrations
////
//// A class's migrations are the `.sql` files in the `migrations` directory
//// beside the module that defines it, such as
//// `src/app/notes/migrations/0001_create_notes.sql` for a class in
//// `src/app/notes.gleam`. Each is named after its file, without `.sql`, and
//// they run in the order of their names. When rays builds the project, with
//// `rays build`, the `rays()` Vite plugin, or the configuration in
//// `@rays/config`, it hands them to the class, so there is no module to
//// import and nothing is generated. A module with migrations can define
//// only one class, so it's clear which class they belong to.
////
//// `apply_migrations` runs the ones an instance hasn't run yet, and
//// records each one in the table `_rays_migrations` in the same
//// transaction, so a migration that fails leaves nothing behind and runs
//// again the next time. Don't rename a migration that has been deployed:
//// its name is what records that it ran.
////
//// The class decides when they run. In `on_wake`, they run before any call
//// is delivered, since instances wake one at a time and the synchronous
//// work of `on_wake` is done first, so every call sees the tables it
//// expects. In a method, they can wait until checks that don't need the
//// database have passed, so a call that fails them never writes to the
//// instance's storage. Either way, each instance migrates its own database
//// the first time it needs to after a deploy.
////
//// ## Values
////
//// SQLite has five kinds of value: integers, floats, text, blobs and null.
//// Values are bound to a statement's `?` placeholders in order. A row's
//// values are decoded by position, with `decode.field(0, ..)` for the
//// first column, so a query's decoder follows its `select`:
////
//// | SQLite  | Bind with       | Decode with                     |
//// | ------- | --------------- | ------------------------------- |
//// | integer | `int`           | `decode.int`                    |
//// | float   | `float`         | `decode.float`                  |
//// | text    | `text`          | `decode.string`                 |
//// | blob    | `blob`          | `decode.bit_array`              |
//// | null    | `null`          | `decode.optional(..)`           |
//// | integer | `bool`, as 1/0  | `decode_bool()`                 |
////
//// Integers are JavaScript numbers, so those beyond 2^53 lose precision.

import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode.{type Decoder}
import gleam/javascript/array.{type Array}
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp.{Match}
import gleam/result
import gleam/set.{type Set}
import rays/durable_object.{type Context}

//
// Values
//

/// A value bound to a `?` placeholder in a statement.
///
pub type Value

/// An integer.
///
pub fn int(value: Int) -> Value {
  to_value(value)
}

/// A float. A float with no fractional part, such as `1.0`, is stored as an
/// integer in a column that isn't declared `real`, as JavaScript doesn't
/// tell the two apart.
///
pub fn float(value: Float) -> Value {
  to_value(value)
}

/// Text.
///
pub fn text(value: String) -> Value {
  to_value(value)
}

/// A blob of the bit array's bytes. A bit array that isn't a whole number of
/// bytes is padded with zero bits to the end of its last byte.
///
pub fn blob(value: BitArray) -> Value {
  let padding = { 8 - bit_array.bit_size(value) % 8 } % 8
  // Concatenation realigns slices that start partway through a byte.
  blob_bytes(<<value:bits, 0:size(padding)>>)
}

/// A bool, as SQLite stores one: the integer 1 for `True`, and 0 for
/// `False`. Decode it with `decode_bool`.
///
pub fn bool(value: Bool) -> Value {
  case value {
    True -> int(1)
    False -> int(0)
  }
}

/// Null.
///
@external(javascript, "./sql_ffi.mts", "null_")
pub fn null() -> Value

/// The value in an `Option`, made with the given function, or null for
/// `None`.
///
/// # Examples
///
/// ```gleam
/// sql.nullable(sql.text, Some("draft"))
/// ```
///
pub fn nullable(inner: fn(a) -> Value, value: Option(a)) -> Value {
  case value {
    Some(value) -> inner(value)
    None -> null()
  }
}

/// Decode a bool stored as an integer, as `bool` stores one: 0 is `False`,
/// and any other integer is `True`.
///
pub fn decode_bool() -> Decoder(Bool) {
  decode.int |> decode.map(fn(value) { value != 0 })
}

//
// Statements
//

/// Runs the given SQL and ignore any returned rows.
/// This binds given values to `?` placeholders.
///
/// To keep a script's changes only if all of its statements succeed, run
/// it in a `transaction` that returns its error.
///
/// ```gleam
/// sql.exec(
///   "insert into notes (body) values (?)",
///   on: params.context,
///   with: [sql.text("acorns")],
/// )
/// ```
///
/// ```gleam
/// sql.exec(
///   "create table notes (id integer primary key, body text not null);
///   create index notes_by_body on notes (body);",
///   on: params.context,
///   with: [],
/// )
/// ```
pub fn exec(
  sql: String,
  on context: Context,
  with values: List(Value),
) -> Result(Nil, QueryError) {
  js_exec(context, sql, array.from_list(values))
  |> result.map_error(error_msg_to_query_error)
}

/// Runs the given SQL and decodes each returned row.
/// This binds given values to `?` placeholders.
///
/// A row is decoded by position: `decode.field(0, ..)` is its first column.
/// For a statement whose rows aren't needed, such as an `insert` without
/// `returning`, use `exec`.
///
/// ```gleam
/// sql.query(
///   "select id, body from notes where body like ?",
///   on: params.context,
///   with: [sql.text("%acorn%")],
///   expecting: {
///     use id <- decode.field(0, decode.int)
///     use body <- decode.field(1, decode.string)
///     decode.success(#(id, body))
///   },
/// )
/// ```
///
pub fn query(
  sql: String,
  on context: Context,
  with values: List(Value),
  expecting decoder: Decoder(a),
) -> Result(List(a), QueryError) {
  use rows <- result.try(
    js_query(context, sql, array.from_list(values))
    |> result.map_error(error_msg_to_query_error),
  )
  list.try_map(array.to_list(rows), decode.run(_, decoder))
  |> result.map_error(RowsNotDecoded)
}

/// Opens up a transaction on the instance's database.
/// Transactions are committed when the callback function returns an `Ok`.
/// If the function returns an `Error` or panics then the transaction is
/// rolled back, and the error is returned or the panic carries on.
///
/// You should not do work inside the transaction beside sql exec/query.
///
/// ```gleam
/// let moved = sql.transaction(params.context, fn() {
///   let debit = sql.exec(
///     "update accounts set balance = balance - ? where id = ?",
///     on: params.context,
///     with: [sql.int(amount), sql.int(from)],
///   )
///   case debit {
///     Error(e) -> Error(e)
///     Ok(Nil) -> {
///       sql.exec(
///         "update accounts set balance = balance + ? where id = ?",
///         on: params.context,
///         with: [sql.int(amount), sql.int(to)],
///       )
///     }
///   }
/// })
/// ```
///
/// You can also use `use` to make the transaction the rest of the block.
///
/// ```gleam
/// let moved = {
///   use <- sql.transaction(params.context)
///   use _ <- result.try(sql.exec(
///     "update accounts set balance = balance - ? where id = ?",
///     on: params.context,
///     with: [sql.int(amount), sql.int(from)],
///   ))
///   sql.exec(
///     "update accounts set balance = balance + ? where id = ?",
///     on: params.context,
///     with: [sql.int(amount), sql.int(to)],
///   )
/// }
/// ```
///
@external(javascript, "./sql_ffi.mts", "transaction")
pub fn transaction(
  context: Context,
  callback: fn() -> Result(a, e),
) -> Result(a, e)

/// Delete everything in the instance's database, all at once.
///
/// Once an instance's storage is empty and it shuts down, it stops existing and will
/// stop billing for storage. It also deletes the instance's alarm(s).
///
/// You should re-run migrations if you intend to re use the DO after calling delete_all.
/// The next `apply_migrations` runs all of them again.
///
pub fn delete_all(context: Context) -> Promise(Nil) {
  use Nil <- promise.map(js_delete_all(context))
  js_set_migrations_applied(context, False)
}

@external(javascript, "./sql_ffi.mts", "delete_all")
fn js_delete_all(context: Context) -> Promise(Nil)

//
// Migrations
//

/// A script of SQL statements that changes the database's schema, from a
/// `.sql` file in the class's `migrations` directory, named after the file
/// without `.sql`. For rays's own tests: classes get theirs from the build.
///
@internal
pub type Migration {
  Migration(name: String, sql: String)
}

/// An error that can occur when applying migrations.
///
pub type MigrationError {
  /// The instance's class has no migrations: there are no `.sql` files in
  /// the `migrations` directory beside the module that defines it, or the
  /// instance wasn't started by a rays build, as under `gleam test`.
  MigrationsNotFound
  /// The table that stores migrations wasn't able to be created or read.
  HistoryNotRead(reason: QueryError)
  /// A migration failed, so none of its changes were kept. The migrations
  /// before it were run and recorded, and the ones after it weren't run.
  MigrationFailed(name: String, reason: QueryError)
}

/// Apply the migrations of the instance's class that haven't run on its
/// database yet, in the order of their file names, and return the names of
/// those it ran.
///
/// A class's migrations are the `.sql` files in the `migrations` directory
/// beside the module that defines it: `src/app/notes/migrations/` for a
/// class in `src/app/notes.gleam`. The build hands them to the class, so
/// there is nothing to import.
///
/// Call it wherever the instance first needs its tables. In `on_wake`, it
/// runs before any call:
///
/// ```gleam
/// durable_object.new(Nil)
/// |> durable_object.on_wake(fn(wake) {
///   let assert Ok(_) = sql.apply_migrations(wake.context)
///   Nil
/// })
/// ```
///
/// Or in a method, after checks that don't need the database, so a call
/// that fails them, such as one from a spammer, never writes the instance's
/// storage, and leaves no stored instance behind:
///
/// ```gleam
/// pub fn add(params: Params(String, Nil)) -> Promise(Result(Int, AddError)) {
///   use body <- result.try(validate(params.args))
///   use _ <- result.try(
///     sql.apply_migrations(params.context) |> result.map_error(StorageFailed),
///   )
///   // ...
/// }
/// ```
///
/// It's cheap to call on every call: once the migrations have been applied,
/// later calls return `Ok([])` without reading the database, until the
/// instance is evicted, or `delete_all` empties it.
///
pub fn apply_migrations(
  context: Context,
) -> Result(List(String), MigrationError) {
  case js_class_migrations(context) {
    Error(Nil) -> Error(MigrationsNotFound)
    Ok(#(True, _)) -> Ok([])
    Ok(#(False, migrations)) -> {
      let migrations =
        list.map(migrations, fn(migration) {
          let #(name, sql) = migration
          Migration(name:, sql:)
        })
      use ran <- result.map(run_migrations(context, migrations))
      js_set_migrations_applied(context, True)
      ran
    }
  }
}

@external(javascript, "../durable_object_ffi.mts", "classMigrations")
fn js_class_migrations(
  context: Context,
) -> Result(#(Bool, List(#(String, String))), Nil)

@external(javascript, "../durable_object_ffi.mts", "setMigrationsApplied")
fn js_set_migrations_applied(context: Context, applied: Bool) -> Nil

/// Run each migration that hasn't run on this instance's database, in the
/// order of the list, and return the names of those it ran. For rays's own
/// tests, which need migrations of their own: classes use
/// `apply_migrations`.
///
@internal
pub fn run_migrations(
  context: Context,
  migrations: List(Migration),
) -> Result(List(String), MigrationError) {
  use applied <- result.try(
    read_history(context) |> result.map_error(HistoryNotRead),
  )
  migrate_loop(context, migrations, applied, [])
}

const create_history =
  "create table if not exists _rays_migrations (
  name text primary key not null,
  applied_at integer not null
)"

fn read_history(context: Context) -> Result(Set(String), QueryError) {
  use _ <- result.try(exec(create_history, on: context, with: []))
  query(
    "select name from _rays_migrations",
    on: context,
    with: [],
    expecting: decode.field(0, decode.string, decode.success),
  )
  |> result.map(set.from_list)
}

fn migrate_loop(
  context: Context,
  migrations: List(Migration),
  applied: Set(String),
  ran: List(String),
) -> Result(List(String), MigrationError) {
  case migrations {
    [] -> Ok(list.reverse(ran))
    [migration, ..rest] ->
      case set.contains(applied, migration.name) {
        True -> migrate_loop(context, rest, applied, ran)
        False -> {
          use _ <- result.try(
            run_migration(context, migration)
            |> result.map_error(MigrationFailed(name: migration.name, reason: _)),
          )
          let applied = set.insert(applied, migration.name)
          migrate_loop(context, rest, applied, [migration.name, ..ran])
        }
      }
  }
}

fn run_migration(
  context: Context,
  migration: Migration,
) -> Result(Nil, QueryError) {
  use <- transaction(context)
  use _ <- result.try(exec(migration.sql, on: context, with: []))
  exec(
    "insert into _rays_migrations (name, applied_at) values (?, unixepoch())",
    on: context,
    with: [text(migration.name)],
  )
}

//
// Errors
//

/// An error that can occur when running SQL.
///
pub type QueryError {
  /// The query couldn't run because of
  /// - a syntax error
  /// - a table that doesn't exist
  /// - a constraint that would be broken
  /// The code field is derived from SQLite, e.g. SQLITE_CONSTRAINT_UNIQUE.
  QueryFailed(code: Option(String), message: String)
  /// The statement ran, but a row didn't match the decoder. 
  /// Changes are kept unless this query was ran in a `transaction`, then this
  /// error would be returned and the transaction is rolled back.
  RowsNotDecoded(errors: List(decode.DecodeError))
}

@internal
pub fn error_msg_to_query_error(message: String) -> QueryError {
  case split_code(message) {
    Some(#(message, code)) -> QueryFailed(code: Some(code), message:)
    None -> QueryFailed(code: None, message:)
  }
}

// Given an error message from sqlite, parse out the message and code.
// Sqlite will give error messages in the format "message: SQLITE_CODE_THING"

const sqlite_error_code =
  "^([\\s\\S]*): (SQLITE_[A-Z0-9_]+)(?: \\(extended: (SQLITE_[A-Z0-9_]+)\\))?$"

fn split_code(message: String) -> Option(#(String, String)) {
  use pattern <- option.then(
    regexp.from_string(sqlite_error_code) |> option.from_result,
  )
  // An unmatched trailing group is omitted from the capture list.
  case regexp.scan(pattern, message) {
    [Match(submatches: [text, Some(_), Some(extended)], ..)] ->
      Some(#(option.unwrap(text, ""), extended))
    [Match(submatches: [text, Some(primary)], ..)] ->
      Some(#(option.unwrap(text, ""), primary))
    _ -> None
  }
}

//
// FFI
//

@external(javascript, "./sql_ffi.mts", "identity")
fn to_value(value: a) -> Value

@external(javascript, "./sql_ffi.mts", "blob")
fn blob_bytes(value: BitArray) -> Value

@external(javascript, "./sql_ffi.mts", "exec")
fn js_exec(
  context: Context,
  sql: String,
  values: Array(Value),
) -> Result(Nil, String)

@external(javascript, "./sql_ffi.mts", "query")
fn js_query(
  context: Context,
  sql: String,
  values: Array(Value),
) -> Result(Array(Dynamic), String)
