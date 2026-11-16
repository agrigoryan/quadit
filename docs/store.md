# The data layer: migrations on goose, and the open question of queries

Two parts. **Migrations** run on goose: that is built, and the first half says how it
works. **Queries** are undecided: the second half is the comparison written before any
code, kept as it was for that decision. What was tried for it was tried outside the
repository, on the real schema, with sqlc v1.31.1; where a number is an estimate it says
so.

## In short

- **Migrations run on goose** (v3.29.0, as a library). The schema files are the ones
  there were, written once for every database; an install made before goose is taken over
  without running anything; on Postgres a lock makes servers that start together take
  turns.
- **Queries: undecided.** The comparison below found that sqlc for every query is a bad
  trade here, and proposed sqlc for about 30 statements with the mapper kept (design B).
  That proposal is on hold while a library in place of the mapper is tried.

## Migrations

### The files

`internal/store/sqlstore/migrations/` holds one set of files for every database:

```
0001_core.sql              every database; column types are macros: {{ID}}, {{TS}}, {{JSON}}, {{BOOL}}, …
0006_search.sqlite.sql     SQLite only
0006_search.postgres.sql   Postgres only
```

A released file is never edited (`TestMigrationsAreFrozen` holds their checksums, which
did not change when goose came in). A change to the schema is a new file with the next
number, recorded by running that test once with `QUADIT_UPDATE_MIGRATIONS=1`. So is a
repair of rows already stored, which runs once, on the upgrade, after the copy is made:
`0008_private_sub_pages` gives the pages under a private page its owner and sharing, which
they lacked when the page was made private after them.

A full restore loads an archive's rows into a database already at the newest schema, so
no upgrade runs on them. An archive records the schema version it was made at (`schema`
in its manifest), and after loading, `UpgradeLoaded` runs again every statement of the
later versions that changes rows (`UPDATE`, `INSERT`, `DELETE`, or `WITH` ahead of one),
leaving out those that change the schema: the restored rows read as an upgrade would have
left them, from the same SQL. An archive made before the version was recorded gets every
one of them, as a page kept from someone wrongly is better than one shown wrongly. A
statement that changes rows must therefore still run on the newest schema.

### What goose is given

goose reads plain SQL, one file per version. `migration_files.go` makes those files in
memory each time a database is opened; nothing is written to disk. For one version it

1. takes the shared file, then the file for this database, if there is one;
2. replaces each `{{TYPE}}` macro with the database's column type (`{{ID}}` is `TEXT` on
   SQLite and `UUID` on Postgres; the table is in `dialect.go`);
3. drops blank lines and lines that are only a comment;
4. puts `-- +goose Up` on top, which goose asks of every file.

So on SQLite goose sees `0006_search.sql` holding `-- +goose Up` and the statements of
`0006_search.sqlite.sql`. goose cuts a file into statements where a line ends in a
semicolon. Step 3 makes those statements the same, byte for byte, as the ones the runner
before goose executed: `TestMigrationsRunAsBefore` keeps that runner's code and compares
(133 statements on SQLite, 134 on Postgres, in 8 versions). An install made before goose
and one made after it have the same schema.

What a migration file may hold is what it could before: plain statements, each ending in
a semicolon at the end of a line. A statement with semicolons inside (a function, a
trigger) needs goose's `StatementBegin` comments, which step 3 would drop: change step 3
when the first one is needed.

### Running them

`migrate.go` hands goose (`goose.NewProvider`) those files, the database, and a record of
applied versions. goose runs each pending version in its own transaction and records it
in the same transaction, so a failed upgrade leaves the last good version in place.
There is no way down: going back is the copy made before an upgrade.

On Postgres goose holds a session lock (an advisory lock on the database) while it
works. A server that finds it taken looks again every second, for up to five minutes;
then it applies whatever is still pending, usually nothing. SQLite has one server.

`MigrateTo(n)` stops at a version (the upgrade tests use it to stand in for an older
binary). `Pending` and `SchemaVersion` read the record and write nothing.

### The record of applied versions

Two tables, written in the same transaction (`ledger.go`):

| Table | Whose | For |
| --- | --- | --- |
| `goose_db_version` | goose's own, in its own SQL | deciding what still has to run |
| `schema_migrations` | the one this code kept before goose | binaries from before goose |

Keeping the second in step means an older binary still reads the version a database is
at: it refuses a schema newer than it knows ("database is at version 8, this binary knows
7"), and it opens the copy that `quadit upgrade --undo` puts back. Had the table been
left alone, an older binary would have run against a schema it does not know.

### Opening a database

In this order (`sqlite.go` and `postgres.go`, then `MigrateTo`):

1. Read the version: from goose's table when it is there, else from
   `schema_migrations`, else 0. Nothing is written.
2. A database newer than the binary is refused, unchanged.
3. If the binary has newer versions and the database is not new, a copy of it as it was
   is made (`quadit.sqlite.before-vN`, or the database `<name>_before_vN`). If the copy
   cannot be made, opening stops here and nothing has been changed.
4. An install from before goose (`schema_migrations`, no table of goose's) is taken over
   (`adopt.go`): goose's table is made and versions 1 to the one it is at are written to
   it as applied, all or nothing, under the same lock goose takes. Nothing is run.
5. goose applies what is newer.

| The database | Copy | Taken over | Run |
| --- | --- | --- | --- |
| New | no | no | every version |
| Before goose, at the newest version | no | yes | nothing |
| Before goose, at 5 of 7 | yes, without goose's table | versions 1–5 | 6 and 7 |
| Kept by goose, up to date | no | no | nothing |
| Kept by goose, behind | yes | no | what is newer |

An install taken over at its own version can still be opened by the older binary as it
is: goose's table is one that binary does not look at. `quadit upgrade --undo` is
unchanged: it puts the copy from step 3 in place and keeps the upgraded database beside
it; when the schema did not change there is no copy, and it says so.

### goose itself

| | |
| --- | --- |
| Version | v3.29.0 (2026-10-11), pinned in `go.mod` |
| Licence | MIT; 11.7k stars; 43 commits since May |
| Added to `go.mod` | goose, `mfridman/interpolate` (MIT), `sethvargo/go-retry` (Apache-2.0), `go.uber.org/multierr` (MIT). Its drivers for other databases are not imported and stay out |
| In the binary | 467 kB more (97.2 MB to 97.7 MB) |

Not v3.30.1, the newest: it asks for `modernc.org/libc` v1.80.2, while the SQLite driver
in use (`modernc.org/sqlite` v1.62.0) says to build it with exactly the libc its own
`go.mod` names, v1.80.1; it also moves eight other modules (gRPC and the Azure SDK among
them). v3.29.0 moves nothing. Two faults fixed in v3.30.1 are stepped around: a lock
object used more than once can stop waiting too early, so `postgresMigrationLock` makes a
new one for every use; and v3.29.0 does not build with `mfridman/interpolate` v0.2.0, so
that module stays at v0.0.2 until goose moves (a `go get -u` would move it). Move to a
newer goose together with the SQLite driver, when that asks for the same libc.

A third database: goose has its SQL for the record already (MySQL among them); it needs
its column types and `hasTable` query in `dialect.go`, and files of its own where its
DDL differs.

### How it was proven

- Statements: `TestMigrationsRunAsBefore`, both databases, as above.
- Taking over, the part-way case with its copy and the way back, a new install and a
  newer database refused: `adopt_test.go` beside `upgrade_test.go` in
  `internal/store/sqlite`. Taking over, the part-way case, servers starting together,
  and "nothing changes when the copy cannot be made": the same file in
  `internal/store/postgres`.
- With real binaries, on SQLite files and on Postgres databases: an install made by the
  binary from before goose (set up, served, tasks added through the command-line tool)
  was opened by the new one. A dump of the database before and after differed only by
  goose's table (and, on SQLite, the `sqlite_sequence` table SQLite keeps for it); the tasks, comments and schema version read the same; the older binary
  then opened it again. An install stopped at version 5 by the older code got 6 and 7,
  its copy was the database as it was to the row, `quadit upgrade --undo` put it back to
  the row, and its schema after the upgrade was the same as an install the older binary
  made. Two new servers started at the same moment on an empty Postgres database both
  came up, with each version applied once.

## Queries: the comparison (undecided)

Written before any code, to answer two questions: how would the code that uses the store
change, and how much repeated code would each choice bring.

- **sqlc for every query: no.** 81% of the calls are "rows of one table where these
  columns equal these values". One 626-line mapper serves them all today with no code per
  query. sqlc needs a named query for each shape (about 420), generates each one twice,
  cannot fill the existing `internal/core` structs, and cannot express the 10% of calls
  whose conditions are decided at run time.
- **sqlc for the statements that are real SQL: about 30 of them** (counters, grouped
  counts, changes to many rows by a range, the workspace lock, the feed notice). They all
  return numbers, so one adapter serves both databases and nothing is written twice.
- The task filter stays one hand-written builder. One static query with optional
  arguments was tried: SQLite then reads the whole table instead of using an index.

The designs are compared below with the same nine call sites.

## sqlc

| | sqlc (`sqlc-dev/sqlc`) |
| --- | --- |
| Licence | MIT |
| Latest release | v1.31.1, 2026-04-22 (the main branch is active: 98 commits since May) |
| Adoption | 18.5k stars |
| In the binary | Nothing: it runs at build time, its output uses only `database/sql` |
| Added to `go.mod` | Nothing, if two defaults are avoided: Postgres JSONB maps to `sqlc-dev/pqtype` and a Postgres array argument to `lib/pq` unless overridden |

What the sqlc trial found, on this schema:

- One query file does compile for both databases when it uses `@name` arguments.
- A nullable column becomes `sql.NullString` or `sql.NullInt64`. The `core` structs hold
  a plain `string` or `int64` and treat the zero value as NULL (140 of 667 columns), and
  37 columns are JSON read into typed fields. sqlc cannot fill a struct it did not
  generate, so every table needs two hand-written conversions.
- A list argument (`IN (...)`) has no form that works on both: `sqlc.slice` is right on
  SQLite and silently becomes a single value on Postgres; the Postgres array form imports
  `lib/pq`. Such queries are written once per database.
- sqlc's SQLite parser rejects the FTS5 search query (`search_index MATCH ?`: "column
  search_index does not exist"), and a non-ASCII character in a query (the `…` in the
  snippet) breaks the query after it. SQLite search stays hand-written.
- A rule in `sqlc vet` can refuse any query that does not name `workspace_id`.
- Generated code: about 23 lines per query, plus 860 lines of row types per database.

## How the store is used today

619 calls of the generic row API in 97 files outside the store (engine 255, server 346,
app 13, backup 5), 32 more in tests. Counted with a type-checking script, not by search.

| Method | Calls | Different shapes | Plain | Ranges, lists, counters | Decided at run time |
| --- | --- | --- | --- | --- | --- |
| `Get` | 187 | 68 | 176 | 0 | 11 |
| `List` | 165 | 131 | 116 | 30 | 19 |
| `Update` | 107 | 88 | 77 | 5 | 25 |
| `Insert` | 63 | 52 | 62 | 0 | 1 |
| `Count` | 52 | 41 | 43 | 7 | 2 |
| `Delete` | 25 | 23 | 16 | 6 | 3 |
| `Upsert` | 10 | 10 | 9 | 0 | 1 |
| `Incr`, `Tally` | 10 | 8 | 0 | 10 | 0 |
| **All** | **619** | **421** | **499 (81%)** | **58 (9%)** | **62 (10%)** |

- **Plain**: one table, columns equal values, perhaps "not deleted", perhaps an order and
  a limit. 119 of the 187 `Get` calls are "by id" over 23 tables.
- **Decided at run time**: the table, the columns or the conditions are values. These are
  helpers built on the generic API: `get[T]` (47 uses), `c.save` and `c.trash` (41 uses
  over 20 tables), the engine's row memo, the bootstrap and export table lists, backups.
- Besides these: `Tasks` 29 calls, `Events` 12, `CountTasks` 3, search 12. They take a
  filter struct and do not change in any design.
- 236 calls are inside a write, 198 on a workspace-bound `DB`, 184 on the unbound store
  (accounts, sessions, settings).

## Nine call sites, as they are and as they would be

Design **C** (goose only) leaves all nine as they are. Design **B** changes only 6 and 8.
Design **A** changes all but 7. The SQL shown was compiled by sqlc for both databases, and
the signatures are what it generated. The "now" code is as it read when the designs were
compared; the places named are where it lives today, where some names have changed since
(`get` is `loadLive`; a read in a handler is a method of the viewer, `who.db`).

**1. One row by id** — `internal/server/deliveries.go:176`

```go
var h core.Webhook                                                             // now, B, C
if err := db.Get(ctx, &h, store.Eq("id", d.WebhookID), store.Live); err != nil {

h, err := db.Webhooks().Get(ctx, d.WebhookID)                                  // A
if err != nil {
```
```sql
-- name: GetWebhook :one
SELECT * FROM webhooks WHERE workspace_id = @workspace_id AND id = @id AND deleted_at IS NULL;
```
```go
func (q *Queries) GetWebhook(ctx context.Context, workspaceID string, iD string) (Webhook, error)

func (w webhooks) Get(ctx context.Context, id string) (core.Webhook, error) {  // by hand, per database
	if !looksUUID(id) {
		return core.Webhook{}, store.ErrNotFound // today the mapper does this for every query
	}
	row, err := w.q.GetWebhook(ctx, w.ws, id)
	return webhookFrom(row), notFound(err) // webhookFrom: 16 fields copied by hand
}
```

**2. Rows under a parent, in order** — `internal/server/task_detail.go:91`

```go
var cms []core.Comment                                                         // now, B, C
if err := b.x.db.List(b.x.ctx(), &cms, store.Q{Where: []store.Cond{store.Eq("task_id", b.t.ID), store.Live}, Order: "created_seq"}); err != nil {

cms, err := b.x.db.Comments().OfTask(b.x.ctx(), b.t.ID)                        // A
```
```sql
-- name: ListTaskComments :many
SELECT * FROM comments
WHERE workspace_id = @workspace_id AND task_id = @task_id AND deleted_at IS NULL
ORDER BY created_seq;
```
```go
func (q *Queries) ListTaskComments(ctx context.Context, workspaceID string, taskID sql.NullString) ([]Comment, error)
```

**3. Insert** — `internal/engine/ch_labels.go:48`

```go
if err := c.tx.Insert(c.ctx, l); err != nil {                                  // now, B, C
if err := c.tx.Labels().Insert(c.ctx, l); err != nil {                         // A
```
```sql
-- name: InsertLabel :exec
INSERT INTO labels (id, workspace_id, project_id, name, color, description, created_at, updated_seq, deleted_at)
VALUES (@id, @workspace_id, @project_id, @name, @color, @description, @created_at, @updated_seq, @deleted_at);
```
```go
func (q *Queries) InsertLabel(ctx context.Context, arg InsertLabelParams) error
// InsertLabelParams: 9 fields, ProjectID sql.NullString, DeletedAt sql.NullInt64; filled by hand from core.Label
```

**4. Set a few named columns** — `internal/server/deliveries.go:244`

```go
db.Update(ctx, "webhook_deliveries", map[string]any{"state": "dead", "error": "the webhook was deleted", "done_at": time.Now().UnixMilli()}, store.Eq("id", d.ID))   // now, B, C

db.Deliveries().End(ctx, d.ID, "dead", "the webhook was deleted", time.Now().UnixMilli())   // A
```
```sql
-- name: EndDelivery :execrows
UPDATE webhook_deliveries SET state = @state, error = @error, done_at = @done_at
WHERE workspace_id = @workspace_id AND id = @id;
```
```go
func (q *Queries) EndDelivery(ctx context.Context, arg EndDeliveryParams) (int64, error)
```
This table is updated in 7 places with 5 different sets of columns: 5 queries.

**5. Delete** — `internal/engine/ch_task_save.go:107`

```go
if _, err := c.tx.Delete(c.ctx, "task_labels", store.Eq("task_id", t.ID), store.Eq("label_id", l)); err != nil {   // now, B, C
if err := c.tx.TaskLabels().Remove(c.ctx, t.ID, l); err != nil {                                                    // A
```
```sql
-- name: DeleteTaskLabel :execrows
DELETE FROM task_labels WHERE workspace_id = @workspace_id AND task_id = @task_id AND label_id = @label_id;
```
```go
func (q *Queries) DeleteTaskLabel(ctx context.Context, workspaceID string, taskID string, labelID string) (int64, error)
```

**6. A count per group** — `internal/server/views_shared.go:134`

```go
rows, err := x.db.Tally(x.ctx(), "comments", []string{"subject_id"}, store.In("task_id", tids), store.Eq("subject_type", "decision_option"), store.Live)   // now, C

counts, err := x.db.CountCommentsPerOption(x.ctx(), tids)                      // B
counts, err := x.db.Comments().CountPerOption(x.ctx(), tids)                   // A
```
```sql
-- name: CountOptionComments :many            -- sqlite file
SELECT subject_id, COUNT(*) AS n FROM comments
WHERE workspace_id = @workspace_id AND task_id IN (sqlc.slice('task_ids'))
  AND subject_type = 'decision_option' AND deleted_at IS NULL
GROUP BY subject_id;
-- postgres file: the same with  task_id = ANY(string_to_array(@task_ids::text, ',')::uuid[])
```
```go
func (q *Queries) CountOptionComments(ctx context.Context, workspaceID string, taskIds []sql.NullString) ([]CountOptionCommentsRow, error) // sqlite
func (q *Queries) CountOptionComments(ctx context.Context, workspaceID string, taskIds string) ([]CountOptionCommentsRow, error)          // postgres
```

**7. The task filter, page by page** — `internal/server/tasks_list.go:165`

```go
tasks, err := x.db.Tasks(x.ctx(), f)                                           // every design
```
Inside the store the filter stays a builder: about 30 optional conditions, 8 sort orders
and "after this row" paging. The other way, one static query with
`(@assignee IS NULL OR t.assignee_id = @assignee)` for each condition, was tried on SQLite
with 10,000 tasks: built for the filter asked, the plan is
`SEARCH t USING INDEX tasks_assignee (workspace_id=? AND assignee_id=?)`; with optional
arguments it is `SCAN t`, the whole table. (Not measured on Postgres.) The builder also
gives "has every one of these labels", one EXISTS per label, which a static query cannot.
"After this row" passes each value once on SQLite and names it by number where it repeats
(`t.activity_seq < ?2 OR (t.activity_seq = ?2 AND t.id < ?3)`): only then does SQLite search
`tasks_activity (workspace_id=? AND activity_seq<?)` from where the page starts instead of
reading the workspace's whole index (a page past row 5,000 of 10,000: 1.2 ms, was 4.3 ms).
Postgres plans both forms alike, so it gets the value once per mention, as before.

**8. Read, check, write inside one write** — `internal/engine/ch_task.go:234`

```go
for {                                                                          // now, C
	if n, err = c.tx.Incr(c.ctx, "projects", "task_counter", 1, store.Eq("id", p.ID)); err != nil {
		return err
	}
	taken, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", p.ID), store.Eq("number", int(n)))

	if n, err = c.tx.NextTaskNumber(c.ctx, p.ID, 1); err != nil {              // B: the counter is named, the count stays
	taken, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", p.ID), store.Eq("number", int(n)))

	if n, err = c.tx.Projects().NextTaskNumber(c.ctx, p.ID, 1); err != nil {   // A
	taken, err := c.tx.Tasks().CountNumbered(c.ctx, p.ID, int(n))
```
```sql
-- name: BumpTaskCounter :one
UPDATE projects SET task_counter = task_counter + @n
WHERE workspace_id = @workspace_id AND id = @id RETURNING task_counter;
-- name: CountTasksNumbered :one
SELECT COUNT(*) FROM tasks WHERE workspace_id = @workspace_id AND project_id = @project_id AND number = @number;
```
```go
func (q *Queries) BumpTaskCounter(ctx context.Context, n int64, workspaceID string, iD string) (int64, error)
func (q *Queries) CountTasksNumbered(ctx context.Context, workspaceID string, projectID string, number int64) (int64, error)
```
These two signatures are the same in both generated packages (with Postgres `integer`
overridden to `int64`), so one Go interface covers both and the adapter is written once.

**9. An update whose columns are decided at run time** — `internal/engine/ch_labels.go:62`, `patch.go:136`

```go
l, err := get[core.Label](c, "label", "id", a.ID)                              // now, B, C
p := newPatch()
if err := p.name("name", a.Name, &l.Name); err != nil { ... }
p.str("color", a.Color, &l.Color)
p.str("description", a.Description, &l.Description)
return c.save(p, "labels", "label", l.ID, st, sid, l.ProjectID, nil)
// and once, in c.save, for all 20 tables:
n, err := c.tx.Update(c.ctx, table, p.set, store.Eq("id", rowID))

l, err := c.label("id", a.ID)                    // A: a finder per kind of row instead of get[T] (47 uses)
...                                              // the patch already keeps l up to date
return c.save(p, "label", l.ID, st, sid, l.ProjectID, nil, func(seq int64) (int64, error) {
	l.UpdatedSeq = seq
	return c.tx.Labels().Save(c.ctx, l)          // the whole row, read and written inside the same write
})
```
```sql
-- name: SaveLabel :execrows
UPDATE labels SET name = @name, color = @color, description = @description, updated_seq = @updated_seq
WHERE workspace_id = @workspace_id AND id = @id;
```
```go
func (q *Queries) SaveLabel(ctx context.Context, arg SaveLabelParams) (int64, error)
```
`COALESCE(sqlc.narg('name'), name)` also compiles, but it cannot set a column back to
NULL (unassign, clear a date) without a second flag per column. Read, change, save is
correct instead, and safe because a write holds the workspace's lock.

## The designs

| | A. sqlc for everything | B. sqlc for real SQL, one mapper for rows | C. goose only |
| --- | --- | --- | --- |
| Call sites changed | all 619, in 97 files; the ~140 that go through `get[T]`, `save`, `trash`, the memo, bootstrap and export get longer | about 28 (`Incr`, `Tally`, counts and changes by range) | 0 |
| Queries to write and keep | about 420 (estimate: one per shape in the table above) | about 30 | 0 |
| Written once for both databases | about 395; the rest (lists, search, upserts that differ) once each | about 24; 6 with a list once each | — |
| The same query repeated per table | about 135: get by id ×23, insert every column ×52, list live rows in order ×40, save ×20. sqlc has no way to say "for every table"; `sqlc.embed` helps joins only, and there are none | none | none |
| Row types | generated, twice; `core` filled by hand: about 1,500 lines (667 columns, both directions) | `core`, as now | `core`, as now |
| Adapter between generated code and the store (estimate) | about 420 methods, written twice (each database's rows are its own Go types): about 5,000 lines, half of them a mirror of the other half | one, about 30 short methods: these queries return numbers, so both generated packages fit one interface | — |
| Generated code, committed (estimate) | about 21,000 lines | about 1,900 lines | 0 |
| Hand-written data-layer code | about 9,500 lines (estimate) in place of 1,448 (`record.go` 626, `queries.go` 520, `migrate.go` 207, `dialect.go` 95) | about 1,750: the same, less ~100 for goose, plus ~170 of SQL and ~250 of adapter and interface | about 1,350 |
| A caller writes | `db.Comments().OfTask(ctx, id)` | as now; a name where the SQL is more than rows of one table | as now |
| Workspace scoping | the adapter is bound to a workspace and passes it, so a caller cannot leave it out; whoever writes a query can (about 330 times), so a test and a `sqlc vet` rule refuse a query on a workspace table without `workspace_id = @workspace_id` | the mapper adds it, as now; the same test for the ~24 sqlc queries on workspace tables | the mapper adds it |
| Task and feed filters | the builder stays (see 7) | the builder stays | the builder stays |
| Backups by table name | keep the mapper for backups alone (~250 lines), or 114 more queries and a switch on the name | as now | as now |
| Tests | every store call in tests is rewritten; a wrong column is caught when generating | as now | as now; a wrong column is caught when a test runs the line |
| Adding MySQL | goose knows it. A third sqlc target: the shared file recompiled, about 70 queries rewritten (`ON CONFLICT`, `RETURNING`), a third 10,000 generated lines and a third copy of the 420 adapter methods | goose knows it. One more dialect for the mapper (upsert form, no `RETURNING` in 2 places) and one more file of ~10 queries | goose knows it. One more dialect for the mapper |
| MySQL, in every design | the 9 unique indexes with a `WHERE` have no MySQL form and need a schema answer; full-text search is a third implementation | | |

Also looked at, not tried:

- **One generated package run on both databases**, by generating for SQLite and rewriting
  `?1` to `$1` for Postgres. It would halve A, but it uses sqlc in a way it is not meant
  for, and Postgres-only type errors would show only at run time.
- **A library in place of the mapper**, under the same store API: `uptrace/bun`
  (BSD-2-Clause, v1.3.0 2026-10-03; its `nullzero` is this code's `,null`) or
  `doug-martin/goqu` (MIT, v9.25.0 2026-11-05). No call site changes and nothing is
  checked earlier; it swaps 626 known lines for a large dependency. Worth a look only if
  MySQL becomes real.

## What was proposed for queries (on hold)

1. goose: done, as above.
2. Design B. `Incr` and `Tally` leave the generic API (they were added to it because real
   SQL had nowhere to live); each becomes a named method backed by a query in a `.sql`
   file. The mapper keeps serving rows of one table; the filter builder stays.
3. Not design A: about 420 queries where there are none today, about a third of them the
   same four statements repeated per table, every adapter written twice, and conversion
   code for 667 columns, to move a wrong column name from "a test fails" to "generation
   fails".

Close calls: B over C (B's whole gain is about 30 named, checked statements and a home
for the next real query; if the build step is not worth that, C is B without step 2 and
nothing else changes).

Layout under B:

```
internal/store/store.go              the interface, as now, with named methods in place of Incr and Tally
internal/store/sqlstore/migrations/  the schema files (as now)
internal/store/sqlstore/             common code: mapper, filter builder, the one adapter, transactions
internal/store/sqlstore/queries/     shared.sql, sqlite.sql, postgres.sql
internal/store/sqlite/               open, copy before upgrade, FTS5 search (by hand), gen/ (sqlc)
internal/store/postgres/             open, copy before upgrade, LISTEN, gen/ (sqlc)
sqlc.yaml                            two targets; overrides: uuid and integer to string and int64
```

Building and testing need neither sqlc nor cgo: generated code is committed, `make
generate` runs sqlc v1.31.1 (pinned, checked), and `make check-generated` (part of `make
test-all`) regenerates into a temporary directory and compares, skipping when sqlc is not
installed.

Still to prove if design B is built:

- Every sqlc query: the same statement as before, or its plan compared at 10,000 tasks.
- The Postgres list form (`string_to_array`) against today's `IN ($1, $2, …)`.
