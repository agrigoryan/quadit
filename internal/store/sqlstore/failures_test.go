package sqlstore_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUnindexReportsAnIndexItCannotRead: on SQLite, Unindex looks the entry
// up first. Only "not indexed" is no error; a lookup that fails is
// reported, not taken for "not indexed".
func TestUnindexReportsAnIndexItCannotRead(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "quadit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	db := st.In(id.New())
	if err := db.Unindex(ctx, id.New()); err != nil {
		t.Fatalf("unindexing what is not indexed: %v", err)
	}
	if err := st.Exec(ctx, `DROP TABLE search_map`); err != nil {
		t.Fatal(err)
	}
	if err := db.Unindex(ctx, id.New()); err == nil {
		t.Fatal("Unindex said nothing when the index could not be read")
	}
}

// TestUndoUpgradePutsTheDatabaseBackWhenTheCopyCannotMove: when the copy
// cannot take the database's place, the upgraded database is put back, and
// the error says so.
func TestUndoUpgradePutsTheDatabaseBackWhenTheCopyCannotMove(t *testing.T) {
	ctx := context.Background()
	path, latest := upgradedSQLite(t)
	copyPath := sqlite.Before(path, latest)
	upgraded := stat(t, path)
	cannotRename(t, copyPath)

	_, _, err := sqlite.UndoUpgrade(ctx, path)
	if err == nil {
		t.Fatal("the undo succeeded with a copy that cannot be moved")
	}
	if !strings.Contains(err.Error(), "every file was put back where it was") {
		t.Errorf("the error does not say where the files are: %v", err)
	}
	if !os.SameFile(upgraded, stat(t, path)) {
		t.Errorf("%s is not the upgraded database any more", path)
	}
	stat(t, copyPath)
	if _, err := os.Stat(strings.Replace(copyPath, ".before-v", ".after-v", 1)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a database was left aside: %v", err)
	}
}

// TestUndoUpgradeStopsWhenASideFileCannotMove: the upgraded database's
// write-ahead log goes aside with it. When it cannot, the copy must not be
// put in place beside a log that is not its own: the undo stops and puts
// everything back.
func TestUndoUpgradeStopsWhenASideFileCannotMove(t *testing.T) {
	ctx := context.Background()
	path, latest := upgradedSQLite(t)
	upgraded := stat(t, path)
	wal := path + "-wal"
	if err := os.WriteFile(wal, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cannotRename(t, wal)

	_, _, err := sqlite.UndoUpgrade(ctx, path)
	if err == nil {
		t.Fatal("the copy was put in place beside the upgraded database's log")
	}
	if !strings.Contains(err.Error(), "every file was put back where it was") {
		t.Errorf("the error does not say where the files are: %v", err)
	}
	if !os.SameFile(upgraded, stat(t, path)) {
		t.Errorf("%s is not the upgraded database any more", path)
	}
	stat(t, sqlite.Before(path, latest))
	stat(t, wal)
}

// TestUndoUpgradeGivesTheNameBackWhenTheCopyIsInUse: on Postgres, when the
// copy cannot take the database's name (something is connected to it), the
// upgraded database gets its name back, and the error says so.
func TestUndoUpgradeGivesTheNameBackWhenTheCopyIsInUse(t *testing.T) {
	base := os.Getenv("QUADIT_TEST_POSTGRES")
	if base == "" {
		t.Skip("QUADIT_TEST_POSTGRES is not set")
	}
	ctx := context.Background()
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, latest, err := sqlstore.New(admin, sqlstore.Postgres).Pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("quadit_undo_%d", time.Now().UnixNano())
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, d := range []string{name, postgres.Before(name, latest), fmt.Sprintf("%s_after_v%d", name, latest)} {
			admin.Exec(`DROP DATABASE IF EXISTS ` + d + ` WITH (FORCE)`)
		}
	})
	urlOf := func(database string) string {
		u, err := url.Parse(base)
		if err != nil {
			t.Fatal(err)
		}
		u.Path = "/" + database
		return u.String()
	}
	versionOf := func(database string) int {
		db, err := sql.Open("pgx", urlOf(database))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var v int
		if err := db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v); err != nil {
			t.Fatalf("%s: %v", database, err)
		}
		return v
	}

	old, err := postgres.OpenAt(ctx, urlOf(name), latest-1)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	upgraded, err := postgres.Open(ctx, urlOf(name)) // leaves the copy
	if err != nil {
		t.Fatal(err)
	}
	upgraded.Close()
	user, err := sql.Open("pgx", urlOf(postgres.Before(name, latest)))
	if err != nil {
		t.Fatal(err)
	}
	defer user.Close()
	if err := user.Ping(); err != nil {
		t.Fatal(err)
	}

	_, _, err = postgres.UndoUpgrade(ctx, urlOf(name))
	if err == nil {
		t.Fatal("the undo succeeded while the copy was in use")
	}
	if !strings.Contains(err.Error(), "the upgraded database is "+name+" again") {
		t.Errorf("the error does not say where the databases are: %v", err)
	}
	if v := versionOf(name); v != latest {
		t.Errorf("%s is at version %d, want the upgraded %d", name, v, latest)
	}
}

// upgradedSQLite makes a database the way an upgrade leaves it: at the
// newest schema version, with the copy from the version before beside it.
func upgradedSQLite(t *testing.T) (path string, latest int) {
	t.Helper()
	ctx := context.Background()
	empty, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer empty.Close()
	if _, latest, err = sqlstore.New(empty, sqlstore.SQLite).Pending(ctx); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(t.TempDir(), "quadit.sqlite")
	old, err := sqlite.OpenAt(ctx, path, latest-1)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	stat(t, sqlite.Before(path, latest))
	return path, latest
}

// cannotRename makes a file immutable for the rest of the test, which makes
// renaming it fail. That needs chflags (macOS); elsewhere it needs root.
func cannotRename(t *testing.T, path string) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("making a rename fail needs chflags, which this system does not have")
	}
	if out, err := exec.Command("chflags", "uchg", path).CombinedOutput(); err != nil {
		t.Fatalf("chflags: %v: %s", err, out)
	}
	t.Cleanup(func() { exec.Command("chflags", "nouchg", path).Run() })
}

func stat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}
