# The data layer: goose, sqlc, and what to change

A proposal, written before any code. It answers two questions: how would the code that
uses the store change, and how much repeated code would each choice bring. Nothing here
is built yet. What was tried was tried outside the repository, on the real schema, with
goose v3.30.1 and sqlc v1.31.1; where a number is an estimate it says so.

## In short

- **goose for migrations: yes.** It replaces the hand-written runner, adds a lock so two
  servers starting together cannot both migrate, and knows MySQL already. An install at
  schema version 7 is taken over without running anything.
- **sqlc for every query: no.** 81% of the calls are "rows of one table where these
  columns equal these values". One 626-line mapper serves them all today with no code per
  query. sqlc needs a named query for each shape (about 420), generates each one twice,
  cannot fill the existing `internal/core` structs, and cannot express the 10% of calls
  whose conditions are decided at run time.
- **sqlc for the statements that are real SQL: yes, about 30 of them** (counters, grouped
  counts, changes to many rows by a range, the workspace lock, the feed notice). They all
  return numbers, so one adapter serves both databases and nothing is written twice.
- The task filter stays one hand-written builder. One static query with optional
  arguments was tried: SQLite then reads the whole table instead of using an index.

The choice is the owner's. The designs are compared below with the same nine call sites.

## The two tools

| | goose (`pressly/goose/v3`) | sqlc (`sqlc-dev/sqlc`) |
| --- | --- | --- |
| Licence | MIT | MIT |
| Latest release | v3.30.1, 2026-11-12 | v1.31.1, 2026-04-22 (the main branch is active: 98 commits since May) |
| Adoption | 11.7k stars, 43 commits since May | 18.5k stars |
| In the binary | Yes: about 1.0 MB, measured on a small program (the binary is 97 MB) | Nothing: it runs at build time, its output uses only `database/sql` |
| Added to `go.mod` | goose, `mfridman/interpolate` (MIT), `sethvargo/go-retry` (Apache-2.0), `go.uber.org/multierr` (MIT). Its other requirements (ClickHouse, MySQL, YDB drivers) are not imported by the library and stay out | Nothing, if two defaults are avoided: Postgres JSONB maps to `sqlc-dev/pqtype` and a Postgres array argument to `lib/pq` unless overridden |

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
the signatures are what it generated.

**1. One row by id** — `internal/server/deliveries.go:112`

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

**2. Rows under a parent, in order** — `internal/server/task_detail.go:113`

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

**3. Insert** — `internal/engine/ch_labels.go:45`

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

**4. Set a few named columns** — `internal/server/deliveries.go:114`

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

**5. Delete** — `internal/engine/ch_task_save.go:100`

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

**6. A count per group** — `internal/server/views_shared.go:106`

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

**7. The task filter, page by page** — `internal/server/tasks_list.go:147`

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

**9. An update whose columns are decided at run time** — `internal/engine/ch_labels.go:66`, `patch.go:109`

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

## Recommendation

1. goose, as below.
2. Design B. `Incr` and `Tally` leave the generic API (they were added to it because real
   SQL had nowhere to live); each becomes a named method backed by a query in a `.sql`
   file. The mapper keeps serving rows of one table; the filter builder stays.
3. Not design A: about 420 queries where there are none today, about a third of them the
   same four statements repeated per table, every adapter written twice, and conversion
   code for 667 columns, to move a wrong column name from "a test fails" to "generation
   fails".

Close calls: B over C (B's whole gain is about 30 named, checked statements and a home
for the next real query; if the build step is not worth that, C is B without step 2 and
nothing else changes), and the layout of migrations (below).

Layout under B:

```
internal/store/store.go              the interface, as now, with named methods in place of Incr and Tally
internal/store/migrations/           the schema files (see below)
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

## Migrations on goose

**Running.** `goose.NewProvider(dialect, db, files)` from an embedded file system, with
goose's Postgres session lock. `MigrateTo(n)` becomes `provider.UpTo`, the schema version
shown by the server becomes `provider.GetDBVersion`, "is an upgrade pending" becomes
`provider.HasPending`. No Down sections: going back is the copy made before an upgrade.
Tried: goose applied today's seven versions to SQLite from files with `-- +goose Up` on
top, and `UpTo(5)` then `Up()` applied 6 and 7.

**Layout.** Two ways, and the owner's "no duplicate code" decides between them:

| | One set of files with type macros, as now | A directory per database |
| --- | --- | --- |
| Files | the 8 there are, unchanged | 14: each of the 6 shared files twice, differing only in type names (about 1,050 more lines) |
| A new migration | written once | written twice |
| What goose reads | a 40-line wrapper around the embedded files that puts `-- +goose Up` on top and expands `{{ID}}`, `{{TS}}` for the database | the files as they are |
| Frozen checksums | unchanged | recorded again, once |
| sqlc's schema (design B) | `make generate` writes the expanded schema to a file per database, checked like other generated code | reads the directories |
| goose's own command-line tool | cannot read the files | can |

Recommended: one set. The binary is the only thing that runs migrations, and the
expansion is then by construction what today's code executes.

**An existing install.** It has `schema_migrations` at 7 and no goose table. On opening:

1. Read the version: from goose's table if it is there, else from `schema_migrations`.
2. If the binary has newer versions and the database is not empty, make the copy first,
   exactly as now (`quadit.sqlite.before-vN`, `<name>_before_vN`). If the copy cannot be
   made, stop: nothing has been changed.
3. If goose's table is missing, create it and record versions 1 to the current one as
   applied, in one transaction, with goose's own store (`database.NewStore`:
   `CreateVersionTable`, `Insert`). Nothing is run. An install at 5 records 1–5.
4. `provider.Up`: an install at 7 runs nothing; one at 5 runs 6 and 7.

**The old `schema_migrations` table** stays, and stays in step: each version goose applies
is also recorded there in the same transaction (a 25-line wrapper around goose's store).
An older binary pointed at a newer database then still refuses to start ("database is at
version 8, this binary knows 7"), where leaving the table untouched would let it run
against a schema it does not know. The other way, a store of our own that makes goose use
`schema_migrations` itself, needs no step 3 but is the part of goose that would otherwise
make a new database free.

**Undo** is unchanged: `quadit upgrade --undo` puts the copy in place and keeps the
upgraded database beside it. The copy holds both tables as they were, so the older binary
opens it as before.

**Frozen migrations**: `TestMigrationsAreFrozen` keeps checking the files goose reads.

## To prove when it is built

- The statements goose runs for versions 1–7 are, one for one, those today's code runs,
  on each database (both splitters dumped and compared).
- An install made by today's binary, opened by the new one: no migration runs, data
  intact, undo as documented. On SQLite files and on a Postgres database.
- Every sqlc query: the same statement as before, or its plan compared at 10,000 tasks.
- The Postgres list form (`string_to_array`) against today's `IN ($1, $2, …)`.
