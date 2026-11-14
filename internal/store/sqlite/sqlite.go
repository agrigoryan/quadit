// Package sqlite opens the default single-file database.
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"

	_ "modernc.org/sqlite" // pure-Go driver: the binary needs no C toolchain

	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// Open opens (and creates if missing) the database file at path and brings
// its schema up to date.
func Open(ctx context.Context, path string) (*sqlstore.Store, error) {
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
		snapshot := fmt.Sprintf("%s.before-v%d", path, latest)
		if _, serr := os.Stat(snapshot); serr != nil {
			if err := s.Exec(ctx, "VACUUM INTO '"+strings.ReplaceAll(snapshot, "'", "''")+"'"); err != nil {
				db.Close()
				return nil, fmt.Errorf("sqlite: could not copy the database before upgrading it (%w); nothing was changed", err)
			}
			fmt.Fprintf(os.Stderr, "quadit: upgrading the database from version %d to %d; a copy of it as it was is at %s\n", cur, latest, snapshot)
		}
	}
	if err := s.Migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
