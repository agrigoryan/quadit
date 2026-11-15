package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// These tests hold the promises made to an install whose schema was put in
// place before goose ran the migrations (it has schema_migrations and no
// table of goose's), and to servers that start at the same moment.

// testServer is the Postgres server tests may make databases on.
type testServer struct {
	t     *testing.T
	base  *url.URL
	admin *sql.DB
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	base := os.Getenv("QUADIT_TEST_POSTGRES")
	if base == "" {
		t.Skip("QUADIT_TEST_POSTGRES is not set")
	}
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	return &testServer{t: t, base: u, admin: admin}
}

// database makes an empty database, dropped with its copies when the test
// ends, and returns its name.
func (s *testServer) database() string {
	s.t.Helper()
	name := fmt.Sprintf("quadit_adopt_%d", time.Now().UnixNano())
	if _, err := s.admin.Exec(`CREATE DATABASE ` + name); err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(func() {
		for _, d := range s.databases(name) {
			s.admin.Exec(`DROP DATABASE IF EXISTS ` + d + ` WITH (FORCE)`)
		}
	})
	return name
}

// databases lists a database and the copies made of it.
func (s *testServer) databases(name string) []string {
	s.t.Helper()
	rows, err := s.admin.Query(`SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2 ORDER BY datname`, name, name+`\_%`)
	if err != nil {
		s.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			s.t.Fatal(err)
		}
		out = append(out, d)
	}
	return out
}

func (s *testServer) url(database string) string {
	u := *s.base
	u.Path = "/" + database
	return u.String()
}

// column runs a query on a database and returns its first column.
func (s *testServer) column(database, q string) []string {
	s.t.Helper()
	db, err := sql.Open("pgx", s.url(database))
	if err != nil {
		s.t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(q)
	if err != nil {
		s.t.Fatalf("%s: %s: %v", database, q, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v sql.NullString
		if err := rows.Scan(&v); err != nil {
			s.t.Fatal(err)
		}
		out = append(out, v.String)
	}
	return out
}

// installBeforeGoose makes an install at a schema version as the runner
// before goose left it, with a workspace in it. The schema is the one that
// runner made (sqlstore's TestMigrationsRunAsBefore), so dropping goose's
// table leaves exactly what it left.
func (s *testServer) installBeforeGoose(version int) string {
	s.t.Helper()
	ctx := context.Background()
	name := s.database()
	st, err := OpenAt(ctx, s.url(name), version)
	if err != nil {
		s.t.Fatal(err)
	}
	if err := st.Insert(ctx, core.Workspace{ID: id.New(), Slug: "games", Name: "Games", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		s.t.Fatal(err)
	}
	st.Close()
	s.column(name, `DROP TABLE goose_db_version`)
	if got := s.column(name, `SELECT COALESCE(MAX(version), 0)::text FROM schema_migrations`); !slices.Equal(got, []string{fmt.Sprint(version)}) {
		s.t.Fatalf("the install before goose is at %v, want %d", got, version)
	}
	return name
}

func (s *testServer) latest() int {
	s.t.Helper()
	st, err := Open(context.Background(), s.url(s.database()))
	if err != nil {
		s.t.Fatal(err)
	}
	defer st.Close()
	_, latest, err := st.Pending(context.Background())
	if err != nil {
		s.t.Fatal(err)
	}
	return latest
}

const (
	gooseVersions = `SELECT version_id::text FROM goose_db_version WHERE is_applied ORDER BY version_id`
	oldVersions   = `SELECT version || ' ' || name || ' ' || applied_at FROM schema_migrations ORDER BY version`
	hasGooseTable = `SELECT COUNT(*)::text FROM pg_tables WHERE tablename = 'goose_db_version'`
)

// upTo is "0", "1", … "n": what goose's table holds at version n.
func upTo(n int) []string {
	out := []string{}
	for v := 0; v <= n; v++ {
		out = append(out, fmt.Sprint(v))
	}
	return out
}

func hasGames(t *testing.T, st store.Store) {
	t.Helper()
	var got core.Workspace
	if err := st.Get(context.Background(), &got, store.Eq("slug", "games")); err != nil {
		t.Fatalf("the data: %v", err)
	}
}

// An install at the newest version is taken over: its versions are written
// to goose's table, nothing is run, and no copy is made, since the schema
// does not change.
func TestTakesOverAnInstallFromBeforeGoose(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	latest := s.latest()
	name := s.installBeforeGoose(latest)
	before := s.column(name, oldVersions)

	st, err := Open(ctx, s.url(name))
	if err != nil {
		t.Fatal(err)
	}
	if v, err := st.SchemaVersion(ctx); err != nil || v != latest {
		t.Fatalf("schema version %d (%v), want %d", v, err, latest)
	}
	hasGames(t, st)
	st.Close()
	if got := s.column(name, gooseVersions); !slices.Equal(got, upTo(latest)) {
		t.Errorf("goose's table has versions %v, want %v", got, upTo(latest))
	}
	if after := s.column(name, oldVersions); !slices.Equal(after, before) {
		t.Errorf("schema_migrations changed:\n%v\nwas\n%v", after, before)
	}
	if all := s.databases(name); len(all) != 1 {
		t.Errorf("a copy was made though the schema did not change: %v", all)
	}
}

// An install part-way gets only the versions after its own. The copy of it
// as it was is made before anything is written: it has no table of goose's.
func TestUpgradesAnInstallFromBeforeGoose(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	latest := s.latest()
	const was = 5
	if latest <= was {
		t.Skip("no version after 5")
	}
	name := s.installBeforeGoose(was)
	before := s.column(name, oldVersions)

	st, err := Open(ctx, s.url(name))
	if err != nil {
		t.Fatal(err)
	}
	if v, err := st.SchemaVersion(ctx); err != nil || v != latest {
		t.Fatalf("schema version %d (%v), want %d", v, err, latest)
	}
	hasGames(t, st)
	st.Close()

	if got := s.column(name, gooseVersions); !slices.Equal(got, upTo(latest)) {
		t.Errorf("goose's table has versions %v, want %v", got, upTo(latest))
	}
	after := s.column(name, oldVersions)
	if len(after) != latest || !slices.Equal(after[:was], before) {
		t.Errorf("schema_migrations is\n%v\nwant the %d rows it had, unchanged, and one for each version after:\n%v", after, was, before)
	}

	copied := Before(name, latest)
	if got := s.column(copied, oldVersions); !slices.Equal(got, before) {
		t.Errorf("the copy's schema_migrations is %v, want %v", got, before)
	}
	if got := s.column(copied, hasGooseTable); !slices.Equal(got, []string{"0"}) {
		t.Errorf("the copy has a table of goose's: it was made after something was written")
	}

	// Going back puts that copy in place, as the older binary knows it.
	if _, _, err := UndoUpgrade(ctx, s.url(name)); err != nil {
		t.Fatal(err)
	}
	if got := s.column(name, hasGooseTable); !slices.Equal(got, []string{"0"}) {
		t.Errorf("after going back the database has a table of goose's")
	}
	if got := s.column(name, oldVersions); !slices.Equal(got, before) {
		t.Errorf("after going back schema_migrations is %v, want %v", got, before)
	}
}

// When the copy cannot be made (here: something else is using the
// database), the upgrade stops and the database is as it was: not even
// goose's table is there.
func TestNothingChangesWhenTheCopyCannotBeMade(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	latest := s.latest()
	const was = 5
	if latest <= was {
		t.Skip("no version after 5")
	}
	name := s.installBeforeGoose(was)
	before := s.column(name, oldVersions)

	other, err := sql.Open("pgx", s.url(name))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err := other.Ping(); err != nil {
		t.Fatal(err)
	}
	_, err = Open(ctx, s.url(name))
	if err == nil || !strings.Contains(err.Error(), "nothing was changed") {
		t.Fatalf("upgrading a database something else is using: %v, want a refusal", err)
	}
	other.Close()
	if got := s.column(name, hasGooseTable); !slices.Equal(got, []string{"0"}) {
		t.Errorf("the refused upgrade left a table of goose's")
	}
	if got := s.column(name, oldVersions); !slices.Equal(got, before) {
		t.Errorf("the refused upgrade changed schema_migrations: %v, was %v", got, before)
	}
	if all := s.databases(name); len(all) != 1 {
		t.Errorf("the refused upgrade left databases behind: %v", all)
	}
}

// Servers started at the same moment on one database take turns: each
// comes up, and every version is applied, or taken over, once.
func TestServersStartingTogether(t *testing.T) {
	s := newTestServer(t)
	latest := s.latest()
	for _, c := range []struct {
		name     string
		database func() string
	}{
		{"on an empty database", s.database},
		{"on an install from before goose", func() string { return s.installBeforeGoose(latest) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			name := c.database()
			const servers = 4
			errs := make([]error, servers)
			start := make(chan struct{})
			var wg sync.WaitGroup
			for i := range servers {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					st, err := Open(context.Background(), s.url(name))
					if err == nil {
						_, err = st.Count(context.Background(), "workspaces")
						st.Close()
					}
					errs[i] = err
				}()
			}
			close(start)
			wg.Wait()
			for i, err := range errs {
				if err != nil {
					t.Errorf("server %d did not come up: %v", i+1, err)
				}
			}
			if got := s.column(name, gooseVersions); !slices.Equal(got, upTo(latest)) {
				t.Errorf("goose's table has versions %v, want each of %v once", got, upTo(latest))
			}
			if got := s.column(name, `SELECT version::text FROM schema_migrations ORDER BY version`); !slices.Equal(got, upTo(latest)[1:]) {
				t.Errorf("schema_migrations has versions %v, want each of %v once", got, upTo(latest)[1:])
			}
		})
	}
}
