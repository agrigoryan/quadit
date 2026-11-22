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
	rows, err := db.Query(`
		SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master
		UNION ALL SELECT 'goose ' || version_id || ' ' || is_applied FROM goose_db_version
		UNION ALL SELECT 'version ' || version || ' ' || name FROM schema_migrations
		UNION ALL SELECT 'user_version ' || user_version FROM pragma_user_version
		UNION ALL SELECT 'application_id ' || application_id FROM pragma_application_id
		UNION ALL SELECT 'page_size ' || page_size FROM pragma_page_size
		UNION ALL SELECT 'auto_vacuum ' || auto_vacuum FROM pragma_auto_vacuum
		UNION ALL SELECT 'encoding ' || encoding FROM pragma_encoding
		ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
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
