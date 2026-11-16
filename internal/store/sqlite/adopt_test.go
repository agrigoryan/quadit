package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// These tests hold the promises made to an install whose schema was put in
// place before goose ran the migrations: it has schema_migrations and no
// table of goose's.

// installBeforeGoose makes such an install at a schema version, with a
// workspace in it, and returns its path. The schema is the one the runner
// before goose made (sqlstore's TestMigrationsRunAsBefore), so dropping
// goose's table leaves exactly what that runner left.
func installBeforeGoose(t *testing.T, version int) string {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "quadit.sqlite")
	st, err := OpenAt(ctx, path, version)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Insert(ctx, core.Workspace{ID: id.New(), Slug: "games", Name: "Games", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	query(t, path, `DROP TABLE goose_db_version`)
	if got := column(t, path, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`); !slices.Equal(got, []string{fmt.Sprint(version)}) {
		t.Fatalf("the install before goose is at %v, want %d", got, version)
	}
	return path
}

// column runs a query on the database file and returns its first column.
func column(t *testing.T, path, q string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(q)
	if err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v sql.NullString
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v.String)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func query(t *testing.T, path, q string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(q); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

const (
	gooseVersions = `SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY version_id`
	oldVersions   = `SELECT version || ' ' || name || ' ' || applied_at FROM schema_migrations ORDER BY version`
	hasGooseTable = `SELECT COUNT(*) FROM sqlite_master WHERE name = 'goose_db_version'`
)

// upTo is "0", "1", … "n": what goose's table holds at version n.
func upTo(n int) []string {
	out := []string{}
	for v := 0; v <= n; v++ {
		out = append(out, fmt.Sprint(v))
	}
	return out
}

func latestVersion(t *testing.T) int {
	t.Helper()
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "quadit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	_, latest, err := st.Pending(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return latest
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
	ctx := context.Background()
	latest := latestVersion(t)
	path := installBeforeGoose(t, latest)
	before := column(t, path, oldVersions)

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := st.SchemaVersion(ctx); err != nil || v != latest {
		t.Fatalf("schema version %d (%v), want %d", v, err, latest)
	}
	hasGames(t, st)
	st.Close()
	if got := column(t, path, gooseVersions); !slices.Equal(got, upTo(latest)) {
		t.Errorf("goose's table has versions %v, want %v", got, upTo(latest))
	}
	if after := column(t, path, oldVersions); !slices.Equal(after, before) {
		t.Errorf("schema_migrations changed:\n%v\nwas\n%v", after, before)
	}
	if copies, _ := filepath.Glob(path + ".before-v*"); len(copies) != 0 {
		t.Errorf("a copy was made though the schema did not change: %v", copies)
	}

	// Opening it again finds it taken over, and does nothing.
	if st, err = Open(ctx, path); err != nil {
		t.Fatal(err)
	}
	st.Close()
	if got := column(t, path, gooseVersions); !slices.Equal(got, upTo(latest)) {
		t.Errorf("after a second start goose's table has versions %v, want %v", got, upTo(latest))
	}
}

// An install part-way gets only the versions after its own. The copy of it
// as it was is made before anything is written: it has no table of goose's.
func TestUpgradesAnInstallFromBeforeGoose(t *testing.T) {
	ctx := context.Background()
	latest := latestVersion(t)
	const was = 5
	if latest <= was {
		t.Skip("no version after 5")
	}
	path := installBeforeGoose(t, was)
	before := column(t, path, oldVersions)

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := st.SchemaVersion(ctx); err != nil || v != latest {
		t.Fatalf("schema version %d (%v), want %d", v, err, latest)
	}
	hasGames(t, st)
	st.Close()

	if got := column(t, path, gooseVersions); !slices.Equal(got, upTo(latest)) {
		t.Errorf("goose's table has versions %v, want %v", got, upTo(latest))
	}
	after := column(t, path, oldVersions)
	if len(after) != latest || !slices.Equal(after[:was], before) {
		t.Errorf("schema_migrations is\n%v\nwant the %d rows it had, unchanged, and one for each version after:\n%v", after, was, before)
	}

	copied := Before(path, latest)
	if got := column(t, copied, oldVersions); !slices.Equal(got, before) {
		t.Errorf("the copy's schema_migrations is %v, want %v", got, before)
	}
	if got := column(t, copied, hasGooseTable); !slices.Equal(got, []string{"0"}) {
		t.Errorf("the copy has a table of goose's: it was made after something was written")
	}

	// Going back puts that copy in place, and the stand-in for the older
	// binary opens it as it always did.
	if _, _, err := UndoUpgrade(ctx, path); err != nil {
		t.Fatal(err)
	}
	if got := column(t, path, hasGooseTable); !slices.Equal(got, []string{"0"}) {
		t.Errorf("after going back the database has a table of goose's")
	}
	if got := column(t, path, oldVersions); !slices.Equal(got, before) {
		t.Errorf("after going back schema_migrations is %v, want %v", got, before)
	}
}

// A new install gets every version, recorded in both tables.
func TestFreshInstallRecordsBothTables(t *testing.T) {
	latest := latestVersion(t)
	path := filepath.Join(t.TempDir(), "quadit.sqlite")
	st, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	if got := column(t, path, gooseVersions); !slices.Equal(got, upTo(latest)) {
		t.Errorf("goose's table has versions %v, want %v", got, upTo(latest))
	}
	old := column(t, path, `SELECT version || ' ' || name FROM schema_migrations ORDER BY version`)
	if len(old) != latest || old[0] != "1 core" {
		t.Errorf("schema_migrations is %v, want versions 1 to %d by name", old, latest)
	}
	if copies, _ := filepath.Glob(path + ".before-v*"); len(copies) != 0 {
		t.Errorf("a new install made a copy: %v", copies)
	}
}

// A database from a newer binary is refused, and left as it is.
func TestRefusesANewerDatabase(t *testing.T) {
	ctx := context.Background()
	latest := latestVersion(t)
	for _, c := range []struct {
		name string
		make func(t *testing.T) string
	}{
		{"kept by goose", func(t *testing.T) string {
			path := installBeforeGoose(t, latest)
			st, err := Open(ctx, path)
			if err != nil {
				t.Fatal(err)
			}
			st.Close()
			query(t, path, fmt.Sprintf(`INSERT INTO goose_db_version (version_id, is_applied) VALUES (%d, 1)`, latest+1))
			return path
		}},
		{"from before goose", func(t *testing.T) string {
			path := installBeforeGoose(t, latest)
			query(t, path, fmt.Sprintf(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (%d, 'later', 1)`, latest+1))
			return path
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			path := c.make(t)
			tables := column(t, path, `SELECT name FROM sqlite_master ORDER BY name`)
			_, err := Open(ctx, path)
			if err == nil || !strings.Contains(err.Error(), "use a newer binary") {
				t.Fatalf("opening a database one version ahead: %v, want a refusal", err)
			}
			if after := column(t, path, `SELECT name FROM sqlite_master ORDER BY name`); !slices.Equal(after, tables) {
				t.Errorf("the refused database was changed: its tables are now %v", after)
			}
			if _, err := os.Stat(Before(path, latest)); err == nil {
				t.Errorf("a copy was made of a database that was refused")
			}
		})
	}
}
