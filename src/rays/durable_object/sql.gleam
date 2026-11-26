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
//// A class creates its tables with migrations, which `migrate` runs when an
//// instance wakes, and its methods query them with `query`:
////
//// ```gleam
//// // src/app/notes.gleam
//// import app/notes/migrations
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
////     let assert Ok(_) = sql.migrate(wake.context, migrations.all)
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
//// A migration is a script of SQL statements with a name. `migrate` runs
//// the ones an instance hasn't run yet, in order, and records each one in
//// the table `_rays_migrations` in the same transaction, so a migration
//// that fails leaves nothing behind and runs again the next time.
////
//// Migrations usually live in `.sql` files in a directory named
//// `migrations`, such as `src/app/notes/migrations/0001_create_notes.sql`.
//// When rays builds the project, with `rays build`, the `rays()` Vite
//// plugin, or the configuration in `@rays/config`, it writes them into the
//// Gleam module beside that directory, `src/app/notes/migrations.gleam`,
//// whose constant `all` lists them in the order of their file names. That
//// module is generated, so keep it in version control, but change the
//// `.sql` files rather than it.
////
//// Instances wake one at a time, and the synchronous work of `on_wake` is
//// done before any call is delivered, so running `migrate` there means every
//// call sees the tables it expects. Each instance migrates its own database
//// the first time it wakes after a deploy.
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

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode.{type Decoder}
import gleam/javascript/promise.{type Promise}
import gleam/list
import gleam/option.{type Option, None, Some}
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
@external(javascript, "./sql_ffi.mts", "blob")
pub fn blob(value: BitArray) -> Value

/// A bool, as SQLite stores one: the integer 1 for `True`, and 0 for
/// `False`. Decode it with `decode_bool`.
///
@external(javascript, "./sql_ffi.mts", "bool")
pub fn bool(value: Bool) -> Value

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

/// An error that can occur when running SQL.
///
pub type QueryError {
  /// The statement couldn't run, such as because of a syntax error, a table
  /// that doesn't exist, or a constraint it would break. The code is
  /// SQLite's, as specific as SQLite gives it, such as
  /// `"SQLITE_CONSTRAINT_UNIQUE"`, or `None` when the runtime refused the
  /// statement before SQLite ran it, such as for having the wrong number of
  /// values.
  QueryFailed(code: Option(String), message: String)
  /// The statement ran, but a row didn't match the decoder. Its changes are
  /// kept, unless it ran in a `transaction` that then returns this error.
  RowsNotDecoded(errors: List(decode.DecodeError))
}

/// Run SQL for its changes, with the given values bound to its `?`
/// placeholders, in order, and ignore any rows it returns.
///
/// It can be a script of several statements separated by semicolons, such
/// as one that creates tables, in which case the values are bound to the
/// last statement. A script with no statements does nothing.
///
/// To keep a script's changes only if all of its statements succeed, run
/// it in a `transaction` that returns its error.
///
/// SQL's own transaction statements, such as `begin`, fail: use
/// `transaction` instead.
///
/// # Examples
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
///
pub fn exec(
  sql: String,
  on context: Context,
  with values: List(Value),
) -> Result(Nil, QueryError) {
  js_exec(context, sql, values) |> result.map_error(query_failed)
}

/// Run one SQL statement with the given values bound to its `?`
/// placeholders, in order, and decode each row it returns.
///
/// A row is decoded by position: `decode.field(0, ..)` is its first column.
/// For a statement whose rows aren't needed, such as an `insert` without
/// `returning`, use `exec`.
///
/// # Examples
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
    js_query(context, sql, values) |> result.map_error(query_failed),
  )
  list.try_map(rows, decode.run(_, decoder))
  |> result.map_error(RowsNotDecoded)
}

/// Runs a function within a transaction on the instance's database.
///
/// If the function returns an `Ok` then the transaction is committed, and
/// its value is returned.
///
/// If the function returns an `Error` or panics then the transaction is
/// rolled back, and the error is returned or the panic carries on.
///
/// The function queries with the same `Context` as the code around it: the
/// database has one connection, so every statement run while the function
/// runs is in the transaction. The function is synchronous, so nothing else
/// runs during it. A transaction can run inside another: if the inner one
/// is rolled back, the outer one keeps its own changes.
///
/// # Examples
///
/// With `use`, the transaction is the rest of the block, so put it in a
/// block of its own to do more after it ends:
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

/// Delete everything in the instance's database, all at once: its tables,
/// their rows, and the record of which migrations have run. Once an
/// instance's storage is empty and it shuts down, it stops existing, and
/// isn't billed for storage. Dropping its tables isn't enough for that, as
/// the database keeps some metadata until it is deleted with this.
///
/// It also deletes the instance's alarm, for a Worker whose compatibility
/// date is 2026-02-24 or later.
///
/// The instance keeps running, and `on_wake` doesn't run again until it is
/// next woken, so run `migrate` again afterwards if its methods will still
/// query its tables.
///
/// # Examples
///
/// ```gleam
/// pub fn close(params: Params(Nil, Nil)) -> Promise(Nil) {
///   sql.delete_all(params.context)
/// }
/// ```
///
@external(javascript, "./sql_ffi.mts", "delete_all")
pub fn delete_all(context: Context) -> Promise(Nil)

//
// Migrations
//

/// A script of SQL statements that changes the database's schema, such as
/// by creating a table. Its name identifies it in the database once it has
/// run, so don't rename a migration that has been deployed.
///
/// The modules rays generates from `.sql` files name each migration after
/// its file, without `.sql`.
///
pub type Migration {
  Migration(name: String, sql: String)
}

/// An error that can occur when running migrations.
///
pub type MigrationError {
  /// The table recording which migrations have run, `_rays_migrations`,
  /// couldn't be created or read.
  HistoryNotRead(reason: QueryError)
  /// A migration failed, so none of its changes were kept. The migrations
  /// before it were run and recorded, and the ones after it weren't run.
  MigrationFailed(name: String, reason: QueryError)
}

/// Run each migration that hasn't run on this instance's database, in the
/// order of the list, and return the names of those it ran.
///
/// Each one runs in a transaction with recording it, so it either runs and
/// is recorded, or leaves nothing behind. Migrations that were recorded
/// before are skipped, even if their SQL has since changed, as are
/// migrations recorded under names that are no longer in the list.
///
/// Call it from `on_wake`, so that every call sees the tables it expects.
/// A panic there stops the instance waking, so the call that woke it fails,
/// and the next call tries again.
///
/// # Examples
///
/// ```gleam
/// durable_object.new(Nil)
/// |> durable_object.on_wake(fn(wake) {
///   let assert Ok(_) = sql.migrate(wake.context, migrations.all)
///   Nil
/// })
/// ```
///
pub fn migrate(
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

/// Turn the runtime's message for a statement that failed into a
/// `QueryFailed`. SQLite's own messages end with its result code, as in
/// `"no such table: notes: SQLITE_ERROR"`, and an extended code when it has
/// one, as in `"...: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"`.
/// The runtime's own have no code.
///
@internal
pub fn query_failed(message: String) -> QueryError {
  case split_code(message) {
    Ok(#(message, code)) -> QueryFailed(code: Some(code), message:)
    Error(Nil) -> QueryFailed(code: None, message:)
  }
}

//
// FFI
//

@external(javascript, "./sql_ffi.mts", "identity")
fn to_value(value: a) -> Value

@external(javascript, "./sql_ffi.mts", "exec")
fn js_exec(
  context: Context,
  sql: String,
  values: List(Value),
) -> Result(Nil, String)

@external(javascript, "./sql_ffi.mts", "query")
fn js_query(
  context: Context,
  sql: String,
  values: List(Value),
) -> Result(List(Dynamic), String)

/// The message without the code at its end, and the code: the extended one
/// if there is one.
///
@external(javascript, "./sql_ffi.mts", "split_code")
fn split_code(message: String) -> Result(#(String, String), Nil)
