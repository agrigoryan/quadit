package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// eachDB runs fn on a fresh, migrated SQLite database and, when
// QUADIT_TEST_POSTGRES is set, on a fresh Postgres schema.
func eachDB(t *testing.T, fn func(t *testing.T, s *Store)) {
	t.Helper()
	t.Run("sqlite", func(t *testing.T) { fn(t, sqliteStore(t)) })
	t.Run("postgres", func(t *testing.T) {
		url := os.Getenv("QUADIT_TEST_POSTGRES")
		if url == "" {
			t.Skip("QUADIT_TEST_POSTGRES is not set")
		}
		schema := fmt.Sprintf("t%d", time.Now().UnixNano())
		admin, err := sql.Open("pgx", url)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
			t.Fatal(err)
		}
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		db, err := sql.Open("pgx", url+sep+"search_path="+schema)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			db.Close()
			admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
			admin.Close()
		})
		s := New(db, Postgres)
		if err := s.Migrate(context.Background()); err != nil {
			t.Fatal(err)
		}
		fn(t, s)
	})
}

func sqliteStore(t *testing.T) *Store {
	t.Helper()
	// Writers wait for each other, as they do in package sqlite.
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "quadit.sqlite")+"?_pragma=busy_timeout(10000)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s := New(db, SQLite)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

// fillTasks makes a workspace with n tasks in two projects whose sort keys
// often tie: few ranks, every priority, some due dates, shared sequence
// numbers. It returns the workspace's id.
func fillTasks(t *testing.T, s *Store, n int) string {
	t.Helper()
	ctx := context.Background()
	ws, me := id.New(), id.New()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.Insert(ctx, core.Workspace{ID: ws, Slug: "w" + ws[:8], Name: "W", CreatedAt: 1, UpdatedAt: 1}))
	must(s.Insert(ctx, core.User{ID: me, Kind: "person", Name: "Me", Email: me + "@example.com", CreatedAt: 1, UpdatedAt: 1}))
	var projects, statuses []string
	for p := 0; p < 2; p++ {
		pid, sid := id.New(), id.New()
		must(s.Insert(ctx, core.Project{ID: pid, WorkspaceID: ws, Key: fmt.Sprintf("P%d", p), Name: "P", CreatedBy: me, CreatedAt: 1, UpdatedAt: 1, CreatedSeq: 1, UpdatedSeq: 1}))
		must(s.Insert(ctx, core.Status{ID: sid, WorkspaceID: ws, ProjectID: pid, Name: "Todo", Category: "unstarted", Rank: "a", IsDefault: true, CreatedAt: 1}))
		projects, statuses = append(projects, pid), append(statuses, sid)
	}
	db := s.In(ws)
	for i := 0; i < n; i++ {
		p := i % 2
		due := ""
		if i%3 == 0 {
			due = fmt.Sprintf("2026-12-%02d", 1+i%4)
		}
		must(db.Insert(ctx, core.Task{ID: id.New(), WorkspaceID: ws, ProjectID: projects[p], Number: i/2 + 1,
			Key: fmt.Sprintf("P%d-%d", p, i/2+1), Title: "task", StatusID: statuses[p], Priority: i % 5,
			Rank: string(rune('a' + i%4)), DueOn: due, CreatedBy: me, CreatedAt: 1, UpdatedAt: 1,
			CreatedSeq: int64(i + 1), UpdatedSeq: int64(i % 7), ActivitySeq: int64(i % 11)}))
	}
	return ws
}

// TestTaskPagesAreTheWholeList reads a list page by page, after the last
// row of each page, under every sort order, and gets the same rows in the
// same order as reading it at once.
func TestTaskPagesAreTheWholeList(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		db := s.In(fillTasks(t, s, 300))
		for _, sort := range TaskSorts() {
			all, err := db.Tasks(ctx, store.TaskFilter{Sort: sort, Limit: 5000})
			if err != nil {
				t.Fatal(sort, err)
			}
			if len(all) != 300 {
				t.Fatalf("%s: %d tasks, want 300", sort, len(all))
			}
			var paged []core.Task
			f := store.TaskFilter{Sort: sort, Limit: 13}
			for {
				page, err := db.Tasks(ctx, f)
				if err != nil {
					t.Fatal(sort, err)
				}
				if len(page) == 0 {
					break
				}
				paged = append(paged, page...)
				f.After = nil
				for _, k := range store.TaskSortKeys[sort] {
					f.After = append(f.After, k.Val(page[len(page)-1]))
				}
			}
			if !slices.Equal(ids(paged), ids(all)) {
				t.Errorf("%s: page by page gives %d tasks in another order than all at once (%d)", sort, len(paged), len(all))
			}
		}
	})
}

func ids(tasks []core.Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.ID
	}
	return out
}

// recorder keeps every statement sent through it, and the last query's
// arguments.
type recorder struct {
	querier
	sent  []string
	last  string
	lastA []any
}

func (r *recorder) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	r.sent, r.last, r.lastA = append(r.sent, query), query, args
	return r.querier.QueryContext(ctx, query, args...)
}

func (r *recorder) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	r.sent = append(r.sent, query)
	return r.querier.QueryRowContext(ctx, query, args...)
}

func (r *recorder) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	r.sent = append(r.sent, query)
	return r.querier.ExecContext(ctx, query, args...)
}

// TestTaskPagesSearchTheIndex holds a second page of a list sorted by
// latest activity, which has an index, to a range search of that index:
// SQLite sees that "activity < X OR (activity = X AND id < Y)" starts at X
// only when X is one parameter. Every sort's second page is logged with its
// plan, for comparison.
func TestTaskPagesSearchTheIndex(t *testing.T) {
	s := sqliteStore(t)
	ws := fillTasks(t, s, 300)
	ctx := context.Background()
	for _, sort := range TaskSorts() {
		rec := &recorder{querier: s.db}
		db := conn{runner: runner{handle: rec, dialect: s.d}, workspaceID: ws}
		first, err := db.Tasks(ctx, store.TaskFilter{Sort: sort, Limit: 20})
		if err != nil {
			t.Fatal(err)
		}
		f := store.TaskFilter{Sort: sort, Limit: 20}
		for _, k := range store.TaskSortKeys[sort] {
			f.After = append(f.After, k.Val(first[len(first)-1]))
		}
		second, err := db.Tasks(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		if len(second) != 20 {
			t.Fatalf("%s: a second page of %d tasks, want 20", sort, len(second))
		}
		plan := queryPlan(t, s.db, rec.last, rec.lastA)
		t.Logf("%s: %s\n%s", sort, rec.last[strings.Index(rec.last, " WHERE "):], plan)
		if sort == "-activity" && !searchesRange(plan, "tasks_activity", "activity_seq") {
			t.Errorf("a second page by latest activity does not search the index from where the page starts:\n%s", plan)
		}
	}
}

// searchesRange tells whether a plan reads the index by a condition on the
// column, past the columns it is equal on: "INDEX tasks_activity
// (workspace_id=? AND activity_seq<?)", whatever the words around it.
func searchesRange(plan, index, col string) bool {
	for _, step := range strings.Split(plan, "\n") {
		_, cond, ok := strings.Cut(step, index)
		if ok && strings.Contains(cond, col) {
			return true
		}
	}
	return false
}

// queryPlan is SQLite's plan for a query, one step per line.
func queryPlan(t *testing.T, db *sql.DB, query string, args []any) string {
	t.Helper()
	rows, err := db.Query("EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var steps []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		steps = append(steps, detail)
	}
	return strings.Join(steps, "\n")
}

// badNames are table names, column names and orders no caller may get into
// a statement: quotes, a semicolon, a comment, a name the table does not
// have, a function call.
var badNames = []string{
	`title"; DROP TABLE tasks; --`,
	`title; DELETE FROM tasks`,
	`title -- x`,
	`title/**/`,
	`"title"`,
	`Title`,
	`nope`,
	`lower(title)`,
	`title DESC`,
	``,
}

// TestNamesOutsideTheSchemaAreRefused hands every way into the mapper a
// table, column or order that is not plainly one of the schema's, and holds
// each to an error before any statement is sent. A valid call is sent with
// its names quoted.
func TestNamesOutsideTheSchemaAreRefused(t *testing.T) {
	s := sqliteStore(t)
	ws := fillTasks(t, s, 3)
	ctx := context.Background()
	rec := &recorder{querier: s.db}
	db := conn{runner: runner{handle: rec, dialect: s.d}, workspaceID: ws}
	var some core.Task
	if err := db.Get(ctx, &some); err != nil {
		t.Fatal(err)
	}
	for _, bad := range badNames {
		entries := map[string]func() error{
			"Get where":    func() error { return db.Get(ctx, &core.Task{}, store.Eq(bad, "x")) },
			"List where":   func() error { var r []core.Task; return db.List(ctx, &r, store.Where(store.Like(bad, "x"))) },
			"List order":   func() error { var r []core.Task; return db.List(ctx, &r, store.Q{Order: bad}) },
			"List -order":  func() error { var r []core.Task; return db.List(ctx, &r, store.Q{Order: "-" + bad}) },
			"List order 2": func() error { var r []core.Task; return db.List(ctx, &r, store.Q{Order: "rank," + bad}) },
			"Count table":  func() error { _, err := db.Count(ctx, bad); return err },
			"Count where":  func() error { _, err := db.Count(ctx, "tasks", store.Null(bad)); return err },
			"Update table": func() error { _, err := db.Update(ctx, bad, map[string]any{"title": "x"}); return err },
			"Update set": func() error {
				_, err := db.Update(ctx, "tasks", map[string]any{bad: "x"}, store.Eq("id", some.ID))
				return err
			},
			"Update where": func() error {
				_, err := db.Update(ctx, "tasks", map[string]any{"title": "x"}, store.Gt(bad, 1))
				return err
			},
			"Delete table":  func() error { _, err := db.Delete(ctx, bad); return err },
			"Delete where":  func() error { _, err := db.Delete(ctx, "tasks", store.In(bad, []string{"x"})); return err },
			"Incr table":    func() error { _, err := db.Incr(ctx, bad, "number", 1); return err },
			"Incr column":   func() error { _, err := db.Incr(ctx, "tasks", bad, 1, store.Eq("id", some.ID)); return err },
			"Tally table":   func() error { _, err := db.Tally(ctx, bad, nil); return err },
			"Tally group":   func() error { _, err := db.Tally(ctx, "tasks", []string{"priority", bad}); return err },
			"Tally where":   func() error { _, err := db.Tally(ctx, "tasks", nil, store.NotNull(bad)); return err },
			"Upsert key":    func() error { return db.Upsert(ctx, some, bad) },
			"Upsert key 2":  func() error { return db.Upsert(ctx, some, "id", bad) },
			"Dump table":    func() error { return s.Dump(ctx, bad, func(map[string]any) error { return nil }) },
			"Load table":    func() error { return s.Load(ctx, bad, []map[string]any{{"id": "x"}}) },
			"Overwrite tbl": func() error { return s.Overwrite(ctx, bad, map[string]any{}, nil) },
			"Overwrite at":  func() error { return s.Overwrite(ctx, "tasks", map[string]any{}, nil, store.Eq(bad, "x")) },
		}
		if bad == "" {
			delete(entries, "List order") // no order at all is an order
		}
		for name, call := range entries {
			rec.sent = nil
			if err := call(); err == nil {
				t.Errorf("%s with %q: no error", name, bad)
			}
			if len(rec.sent) > 0 {
				t.Errorf("%s with %q: sent %q", name, bad, rec.sent)
			}
		}
	}
	var after []core.Task
	if err := db.List(ctx, &after, store.Q{}); err != nil || len(after) != 3 {
		t.Fatalf("after the bad names: %d tasks (%v), want the 3 there were", len(after), err)
	}

	rec.sent = nil
	var rows []core.Task
	if err := db.List(ctx, &rows, store.Q{Where: []store.Cond{store.Eq("key", some.Key)}, Order: "rank,-id"}); err != nil {
		t.Fatal(err)
	}
	if err := db.Upsert(ctx, core.TaskKey{WorkspaceID: ws, Key: "OLD-1", TaskID: some.ID, At: 1}, "workspace_id", "key"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Incr(ctx, "tasks", "number", 0, store.Eq("id", some.ID)); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		` FROM "tasks" WHERE "workspace_id" = ? AND "key" = ? ORDER BY "rank", "id" DESC`,
		`ON CONFLICT ("workspace_id", "key") DO UPDATE SET "task_id" = excluded."task_id"`,
		`UPDATE "tasks" SET "number" = "number" + ? WHERE "workspace_id" = ? AND "id" = ? RETURNING "number"`,
	} {
		if !slices.ContainsFunc(rec.sent, func(q string) bool { return strings.Contains(q, want) }) {
			t.Errorf("no statement has %s:\n%s", want, strings.Join(rec.sent, "\n"))
		}
	}
}
