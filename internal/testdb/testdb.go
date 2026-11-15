// Package testdb opens every kind of database for tests, so one test body
// proves the same behavior on each.
//
// SQLite always runs, in a temporary file. Postgres runs when
// QUADIT_TEST_POSTGRES holds a connection URL, for example
//
//	QUADIT_TEST_POSTGRES=postgres://postgres:quadit@127.0.0.1:54329/quadit go test ./...
//
// Each Postgres test gets its own schema, dropped when the test ends.
package testdb

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"
)

// Each runs fn once per database kind, as a subtest named after it.
func Each(t *testing.T, fn func(t *testing.T, st store.Store)) {
	t.Helper()
	t.Run("sqlite", func(t *testing.T) { fn(t, SQLite(t)) })
	t.Run("postgres", func(t *testing.T) {
		url := os.Getenv("QUADIT_TEST_POSTGRES")
		if url == "" {
			t.Skip("QUADIT_TEST_POSTGRES is not set")
		}
		schema := fmt.Sprintf("t%d", time.Now().UnixNano())
		ctx := context.Background()
		admin, err := sql.Open("pgx", url)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
			t.Fatal(err)
		}
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		st, err := postgres.Open(ctx, url+sep+"search_path="+schema)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := st.Close(); err != nil {
				t.Logf("closing the test database: %v", err)
			}
			if _, err := admin.ExecContext(ctx, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
				t.Logf("schema %s is left behind: %v", schema, err)
			}
			admin.Close()
		})
		fn(t, st)
	})
}

// SQLite opens a fresh SQLite database in a temporary directory.
func SQLite(t *testing.T) store.Store {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "quadit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Logf("closing the test database: %v", err)
		}
	})
	return st
}
