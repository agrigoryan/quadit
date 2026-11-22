package testdb

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store/sqlite"
)

// The copy a test's SQLite database starts from is the database migrating
// a new file makes: the same tables, indexes, triggers and records of the
// versions applied, and the same header values.
func TestTheSQLiteCopyIsAFreshlyMigratedDatabase(t *testing.T) {
	ctx := context.Background()
	migrated := filepath.Join(t.TempDir(), "migrated.sqlite")
	st, err := sqlite.Open(ctx, migrated)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	fresh, err := newestSQLite()
	if err != nil {
		t.Fatal(err)
	}
	copied := filepath.Join(t.TempDir(), "copied.sqlite")
	if err := os.WriteFile(copied, fresh, 0o600); err != nil {
		t.Fatal(err)
	}
	want, got := describe(t, migrated), describe(t, copied)
	if !slices.Equal(got, want) {
		t.Fatalf("the copy differs from a migrated database:\n got %q\nwant %q", got, want)
	}
}

// describe lists what a database file holds besides rows of data: its
// schema, the versions applied, and the header values a program may set.
func describe(t *testing.T, path string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var out []string
	for _, query := range []string{
		`SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master ORDER BY type, name`,
		`SELECT version_id || ' ' || is_applied FROM goose_db_version ORDER BY version_id`,
		`SELECT version || ' ' || name FROM schema_migrations ORDER BY version`,
		`PRAGMA user_version`,
		`PRAGMA application_id`,
		`PRAGMA page_size`,
		`PRAGMA auto_vacuum`,
		`PRAGMA encoding`,
	} {
		rows, err := db.Query(query)
		if err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			out = append(out, line)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
	}
	return out
}

func TestOneTestAtATimeHasTheTurn(t *testing.T) {
	var q turn
	first := q.take("TestA")
	again := q.take("TestA") // a test with the turn takes it at once
	took := make(chan func())
	go func() { took <- q.take("TestB") }()

	first()
	select {
	case <-took:
		t.Fatal("another test had the turn while the first still held it once")
	case <-time.After(50 * time.Millisecond):
	}
	again()
	select {
	case giveBack := <-took:
		giveBack()
	case <-time.After(5 * time.Second):
		t.Fatal("the turn given back did not go to the test waiting for it")
	}
}
