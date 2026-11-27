//// What the tests of `rays/durable_object/sql` run inside an instance. Each
//// function takes the instance's context, and returns what it found as a
//// string, made with `string.inspect`, for the test to compare.

import gleam/dynamic/decode
import gleam/javascript/promise.{type Promise}
import gleam/option.{Some}
import gleam/result
import gleam/string
import rays/durable_object.{type Context}
import rays/durable_object/sql.{Migration}

/// Bind one value of each kind, and decode them back.
pub fn round_trip(context: Context) -> String {
  let assert <<_:4, slice:bits>> = <<10:4, 188>>
  sql.query(
    "select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?",
    on: context,
    with: [
      sql.int(-7),
      sql.float(1.5),
      sql.text("héllo \"there\""),
      sql.blob(<<1, 2, 255>>),
      sql.blob(<<1:4>>),
      sql.bool(True),
      sql.bool(False),
      sql.null(),
      sql.nullable(sql.int, Some(3)),
      sql.blob(slice),
    ],
    expecting: {
      use int <- decode.field(0, decode.int)
      use float <- decode.field(1, decode.float)
      use text <- decode.field(2, decode.string)
      use blob <- decode.field(3, decode.bit_array)
      use padded <- decode.field(4, decode.bit_array)
      use yes <- decode.field(5, sql.decode_bool())
      use no <- decode.field(6, sql.decode_bool())
      use null <- decode.field(7, decode.optional(decode.int))
      use some <- decode.field(8, decode.optional(decode.int))
      use sliced <- decode.field(9, decode.bit_array)
      decode.success(#(
        int,
        float,
        text,
        blob,
        padded,
        yes,
        no,
        null,
        some,
        sliced,
      ))
    },
  )
  |> string.inspect
}

/// Run a script of several statements, an empty one, and one with SQL's
/// own transaction statement.
pub fn scripts(context: Context) -> String {
  let created =
    sql.exec(
      "create table scripted (a integer);
      insert into scripted values (1);
      insert into scripted values (?);",
      on: context,
      with: [sql.int(2)],
    )
  let rows =
    sql.query(
      "select count(*) from scripted",
      on: context,
      with: [],
      expecting: decode.field(0, decode.int, decode.success),
    )
  let empty = sql.exec("-- nothing to do\n", on: context, with: [])
  let begin =
    sql.exec("begin transaction", on: context, with: []) |> result.is_error
  string.inspect(#(created, rows, empty, begin))
}

/// The errors for a statement that breaks a constraint, refers to a table
/// that doesn't exist, has the wrong number of values, and returns rows the
/// decoder doesn't match.
pub fn errors(context: Context) -> String {
  let assert Ok(Nil) =
    sql.exec("create table people (name text unique)", on: context, with: [])
  let insert = fn() {
    sql.exec("insert into people (name) values (?)", on: context, with: [
      sql.text("Lucy"),
    ])
  }
  let assert Ok(Nil) = insert()
  let unique = insert()
  let missing = sql.exec("select * from nowhere", on: context, with: [])
  let values =
    sql.query("select ?, ?", on: context, with: [sql.int(1)], expecting: {
      decode.success(Nil)
    })
  let rows =
    sql.query(
      "select name from people",
      on: context,
      with: [],
      expecting: decode.field(0, decode.int, decode.success),
    )
  string.inspect(#(unique, missing, values, rows))
}

fn count(context: Context, table: String) -> Int {
  let assert Ok([count]) =
    sql.query(
      "select count(*) from " <> table,
      on: context,
      with: [],
      expecting: decode.field(0, decode.int, decode.success),
    )
  count
}

fn add(context: Context, table: String) -> Result(Nil, sql.QueryError) {
  sql.exec("insert into " <> table <> " values (?)", on: context, with: [
    sql.int(1),
  ])
}

/// Transactions that return `Ok`, return an `Error`, and roll back inside
/// one that commits, and how many rows each left.
pub fn transactions(context: Context) -> String {
  let assert Ok(Nil) =
    sql.exec("create table ledger (a integer)", on: context, with: [])
  let committed = {
    use <- sql.transaction(context)
    use _ <- result.try(add(context, "ledger"))
    add(context, "ledger")
  }
  let after_commit = count(context, "ledger")
  let rolled_back = {
    use <- sql.transaction(context)
    let assert Ok(Nil) = add(context, "ledger")
    Error("changed my mind")
  }
  let after_rollback = count(context, "ledger")
  let nested = {
    use <- sql.transaction(context)
    let assert Ok(Nil) = add(context, "ledger")
    let inner = {
      use <- sql.transaction(context)
      let assert Ok(Nil) = add(context, "ledger")
      Error("inner")
    }
    Ok(inner)
  }
  let after_nested = count(context, "ledger")
  string.inspect(#(
    committed,
    after_commit,
    rolled_back,
    after_rollback,
    nested,
    after_nested,
  ))
}

/// Add a row in a transaction that then panics.
pub fn panic_in_transaction(context: Context) -> Nil {
  let assert Ok(Nil) =
    sql.exec("create table panicked (a integer)", on: context, with: [])
  let _ = {
    use <- sql.transaction(context)
    let assert Ok(Nil) = add(context, "panicked")
    panic as "the transaction crashed"
  }
  Nil
}

pub fn panicked_rows(context: Context) -> Int {
  count(context, "panicked")
}

/// The names in the history of migrations, in the order they ran.
pub fn history(context: Context) -> String {
  sql.query(
    "select name from _rays_migrations order by rowid",
    on: context,
    with: [],
    expecting: decode.field(0, decode.string, decode.success),
  )
  |> string.inspect
}

/// The tables whose names start with `step_`.
pub fn steps(context: Context) -> String {
  sql.query(
    "select name from sqlite_master where type = 'table' and name like 'step_%' order by name",
    on: context,
    with: [],
    expecting: decode.field(0, decode.string, decode.success),
  )
  |> string.inspect
}

/// Run migrations whose second one fails partway, after creating a table.
pub fn migrate_broken(context: Context) -> String {
  sql.run_migrations(context, [
    Migration(name: "0100_first", sql: "create table step_first (a)"),
    Migration(
      name: "0101_broken",
      sql: "create table step_half (a); insert into nowhere values (1);",
    ),
    Migration(name: "0102_after", sql: "create table step_after (a)"),
  ])
  |> string.inspect
}

/// The same migrations, with the broken one fixed.
pub fn migrate_fixed(context: Context) -> String {
  sql.run_migrations(context, [
    Migration(name: "0100_first", sql: "create table step_first (a)"),
    Migration(name: "0101_broken", sql: "create table step_half (a);"),
    Migration(name: "0102_after", sql: "create table step_after (a)"),
  ])
  |> string.inspect
}

/// Delete the database, then say what is left of it, and what migrating it
/// again runs.
pub fn delete_and_migrate(context: Context) -> Promise(String) {
  use Nil <- promise.map(sql.delete_all(context))
  let tables =
    sql.query(
      "select name from sqlite_master where type = 'table' and name not like '_cf_%'",
      on: context,
      with: [],
      expecting: decode.field(0, decode.string, decode.success),
    )
  let migrated = sql.apply_migrations(context)
  string.inspect(#(tables, migrated))
}
