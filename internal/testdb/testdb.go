// Package testdb opens every kind of database for tests, so one test body
// proves the same behavior on each.
//
// SQLite always runs, in a temporary file. Postgres runs when
// QUADIT_TEST_POSTGRES holds a connection URL, for example
//
//	QUADIT_TEST_POSTGRES=postgres://postgres:quadit@127.0.0.1:54329/quadit go test ./...
//
// Each Postgres test gets its own schema, dropped when the test ends, and
// one test at a time in a test binary has any (postgresTurn), though the
// tests themselves may run in parallel.
package testdb

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"
)

// Each runs fn once per database kind, as a subtest named after it.
func Each(t *testing.T, fn func(t *testing.T, st store.Store)) {
	t.Helper()
	EachAt(t, 0, fn)
}

// EachAt is Each with the schema at a version (0 = the newest), standing
// in for an older binary's database.
func EachAt(t *testing.T, version int, fn func(t *testing.T, st store.Store)) {
	t.Helper()
	t.Run("sqlite", func(t *testing.T) { fn(t, sqliteAt(t, version)) })
	t.Run("postgres", func(t *testing.T) { fn(t, postgresAt(t, version)) })
}

// Postgres opens a fresh Postgres database (a schema of its own), and
// skips the test when QUADIT_TEST_POSTGRES is not set.
func Postgres(t *testing.T) store.Store {
	t.Helper()
	return postgresAt(t, 0)
}

// postgresAt is Postgres with the schema at a version (0 = the newest).
func postgresAt(t *testing.T, version int) store.Store {
	t.Helper()
	url := os.Getenv("QUADIT_TEST_POSTGRES")
	if url == "" {
		t.Skip("QUADIT_TEST_POSTGRES is not set")
	}
	giveBack := postgresTurn.take(topLevel(t))
	t.Cleanup(giveBack) // after the cleanup below: the last to run
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
	st, err := postgres.OpenAt(ctx, url+sep+"search_path="+schema, version)
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
	return st
}

// postgresTurn lets one test at a time in a test binary have Postgres
// databases, though the tests themselves run in parallel. Its databases are
// schemas of one database, and a server listening there hears every
// other's notifications: servers side by side would wake each other, and
// open more connections than the database takes.
var postgresTurn turn

// turn is had by one test at a time, for as long as it holds any of what
// it took the turn for.
type turn struct {
	mu     sync.Mutex
	holder string        // the test whose turn it is, or ""
	held   int           // how many times it took the turn without giving it back
	given  chan struct{} // closed when holder gives the turn back
}

// take waits until it is test's turn, and returns what gives it back. A
// test that has the turn may take it again: each take is given back.
func (q *turn) take(test string) (giveBack func()) {
	q.mu.Lock()
	for q.holder != "" && q.holder != test {
		given := q.given
		q.mu.Unlock()
		<-given
		q.mu.Lock()
	}
	if q.holder == "" {
		q.holder, q.given = test, make(chan struct{})
	}
	q.held++
	q.mu.Unlock()
	return func() {
		q.mu.Lock()
		defer q.mu.Unlock()
		q.held--
		if q.held == 0 {
			q.holder = ""
			close(q.given)
		}
	}
}

// topLevel is the name of the test t is, or is a subtest of.
func topLevel(t *testing.T) string {
	name, _, _ := strings.Cut(t.Name(), "/")
	return name
}

// SQLite opens a fresh SQLite database in a temporary directory.
func SQLite(t *testing.T) store.Store {
	t.Helper()
	return sqliteAt(t, 0)
}

// sqliteAt is SQLite with the schema at a version (0 = the newest).
func sqliteAt(t *testing.T, version int) store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "quadit.sqlite")
	if version == 0 {
		// The newest schema starts as a copy of a database migrated once
		// per test binary: migrating takes a second under the race
		// detector, and leaves the same file every time. Opening it below
		// still goes the whole way a server's start does.
		fresh, err := newestSQLite()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, fresh, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	st, err := sqlite.OpenAt(context.Background(), path, version)
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

// newestSQLite is the file of a fresh SQLite database with the newest
// schema, made the first time it is asked for.
var newestSQLite = sync.OnceValues(func() ([]byte, error) {
	dir, err := os.MkdirTemp("", "quadit-testdb-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(dir, "migrated.sqlite"))
	if err != nil {
		return nil, err
	}
	// VACUUM INTO writes the whole database to one file, with nothing left
	// in the write-ahead log beside it.
	fresh := filepath.Join(dir, "fresh.sqlite")
	err = st.Exec(ctx, "VACUUM INTO '"+strings.ReplaceAll(fresh, "'", "''")+"'")
	if cerr := st.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	return os.ReadFile(fresh)
})
