// Package sqlite opens the default single-file database.
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite" // pure-Go driver: the binary needs no C toolchain

	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// Open opens (and creates if missing) the database file at path and brings
// its schema up to date.
func Open(ctx context.Context, path string) (*sqlstore.Store, error) { return OpenAt(ctx, path, 0) }

// Before names the copy of the database made before it was upgraded to a
// schema version.
func Before(path string, version int) string { return fmt.Sprintf("%s.before-v%d", path, version) }

// UndoUpgrade puts back the copy made before the last upgrade, and keeps
// the upgraded database beside it. The older binary then runs as before.
func UndoUpgrade(ctx context.Context, path string) (from, to string, err error) {
	copies, _ := filepath.Glob(path + ".before-v*")
	if len(copies) == 0 {
		return "", "", fmt.Errorf("there is no copy from before an upgrade beside %s", path)
	}
	sort.Slice(copies, func(i, j int) bool {
		a, _ := strconv.Atoi(copies[i][strings.LastIndex(copies[i], "-v")+2:])
		b, _ := strconv.Atoi(copies[j][strings.LastIndex(copies[j], "-v")+2:])
		return a > b
	})
	newest := copies[0]
	// Only a real database goes back in place: a file of that name that is
	// empty or something else would replace the live one with nothing.
	if err := looksLikeOurs(ctx, newest); err != nil {
		return "", "", fmt.Errorf("%s is not a copy of the database (%w); nothing was changed", newest, err)
	}
	aside := strings.Replace(newest, ".before-v", ".after-v", 1)
	for _, suffix := range []string{"-wal", "-shm"} {
		os.Remove(path + suffix) // the upgraded database's side files do not belong to the copy
	}
	if err := os.Rename(path, aside); err != nil {
		return "", "", err
	}
	if err := os.Rename(newest, path); err != nil {
		os.Rename(aside, path)
		return "", "", err
	}
	return newest, aside, nil
}

// OpenAt is Open stopping at a schema version (0 = the newest), which
// stands in for an older binary.
func OpenAt(ctx context.Context, path string, upTo int) (*sqlstore.Store, error) {
	// WAL lets readers run while one writer writes. Write transactions take
	// the write lock when they begin, so two writers queue instead of one
	// failing halfway with "database is locked".
	v := url.Values{}
	v.Add("_pragma", "journal_mode(WAL)")
	v.Add("_pragma", "synchronous(NORMAL)")
	v.Add("_pragma", "foreign_keys(1)")
	v.Add("_pragma", "busy_timeout(10000)")
	v.Set("_txlock", "immediate")
	db, err := sql.Open("sqlite", "file:"+path+"?"+v.Encode())
	if err != nil {
		return nil, fmt.Errorf("sqlite: %w", err)
	}
	s := sqlstore.New(db, sqlstore.SQLite)
	if err := s.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	// An upgrade that changes the schema first leaves a copy of the database
	// as it was, beside it. Going back is: stop, put the copy in place, run
	// the old binary.
	if cur, latest, err := s.Pending(ctx); err == nil && cur > 0 && cur < latest {
		snapshot := Before(path, latest)
		if _, serr := os.Stat(snapshot); serr != nil {
			if err := s.Exec(ctx, "VACUUM INTO '"+strings.ReplaceAll(snapshot, "'", "''")+"'"); err != nil {
				db.Close()
				return nil, fmt.Errorf("sqlite: could not copy the database before upgrading it (%w); nothing was changed", err)
			}
			fmt.Fprintf(os.Stderr, "quadit: upgrading the database from version %d to %d; a copy of it as it was is at %s\n", cur, latest, snapshot)
		}
	}
	if err := s.MigrateTo(ctx, upTo); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// looksLikeOurs checks that a file is a database of ours with data in it.
func looksLikeOurs(ctx context.Context, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return fmt.Errorf("the file is empty")
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	var version, workspaces int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&version); err != nil || version == 0 {
		return fmt.Errorf("it has no schema of ours")
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces`).Scan(&workspaces); err != nil {
		return err
	}
	return nil
}
