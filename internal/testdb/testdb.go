// Package testdb opens every kind of database for tests, so one test body
// proves the same behaviour on each.
//
// SQLite always runs, in a temporary file. Postgres runs when
// QUADIT_TEST_POSTGRES holds a connection URL, for example
//
//	QUADIT_TEST_POSTGRES=postgres://postgres:quadit@127.0.0.1:54329/quadit go test ./...
package testdb

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"
)

// Each runs fn once per database kind, as a subtest named after it.
func Each(t *testing.T, fn func(t *testing.T, st store.Store)) {
	t.Helper()
	t.Run("sqlite", func(t *testing.T) {
		st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "quadit.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { st.Close() })
		fn(t, st)
	})
	t.Run("postgres", func(t *testing.T) {
		url := os.Getenv("QUADIT_TEST_POSTGRES")
		if url == "" {
			t.Skip("QUADIT_TEST_POSTGRES is not set")
		}
		st, err := postgres.Open(context.Background(), url)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { st.Close() })
		fn(t, st)
	})
}
