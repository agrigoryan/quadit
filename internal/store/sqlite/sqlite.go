// Package sqlite opens the default single-file database. Everything is in
// sqlite.go: opening (with a copy made before an upgrade) and undoing the
// last upgrade from that copy; the data layer itself is package sqlstore.
package sqlite

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
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

// sideFiles are the files SQLite keeps beside a database in WAL mode, by
// their suffix: the writes not yet folded into the database, and their
// index. They belong to their database and move with it.
var sideFiles = []string{"-wal", "-shm"}

// UndoUpgrade puts back the copy made before the last upgrade, and keeps
// the upgraded database beside it. The older binary then runs as before.
func UndoUpgrade(ctx context.Context, path string) (from, to string, err error) {
	newest, err := newestCopy(path)
	if err != nil {
		return "", "", err
	}
	// Only a real database goes back in place: a file of that name that is
	// empty or something else would replace the live one with nothing.
	if err := looksLikeOurs(ctx, newest); err != nil {
		return "", "", fmt.Errorf("%s is not a copy of the database (%w); nothing was changed", newest, err)
	}
	// "<path>.before-vN" goes back in place; the upgraded database goes
	// aside as "<path>.after-vN". N is read from the copy's own name: a
	// folder in the path may hold ".before-v" too.
	aside := path + ".after-v" + strings.TrimPrefix(filepath.Base(newest), filepath.Base(path)+".before-v")
	if _, err := os.Stat(aside); err == nil {
		return "", "", fmt.Errorf("%s from an earlier undo is in the way; move it away first (nothing was changed)", aside)
	}
	if err := swapIn(path, newest, aside); err != nil {
		return "", "", err
	}
	return newest, aside, nil
}

// newestCopy finds the copy made before the last upgrade: of the files
// "<path>.before-vN", the one with the largest N.
func newestCopy(path string) (string, error) {
	// The folder is listed and the names compared, rather than globbed: a
	// path is not a pattern, and a folder named with [, * or ? is not one.
	dir, base := filepath.Split(path)
	entries, err := os.ReadDir(filepath.Clean(dir))
	if err != nil {
		return "", fmt.Errorf("looking for a copy from before an upgrade beside %s: %w", path, err)
	}
	var copies []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), base+".before-v") {
			copies = append(copies, filepath.Join(dir, e.Name()))
		}
	}
	if len(copies) == 0 {
		return "", fmt.Errorf("there is no copy from before an upgrade beside %s", path)
	}
	slices.SortStableFunc(copies, func(a, b string) int { return cmp.Compare(copyVersion(b), copyVersion(a)) })
	return copies[0], nil
}

// copyVersion reads N from "<path>.before-vN". A name that does not end in
// a number counts as 0, the last choice.
func copyVersion(name string) int {
	version, err := strconv.Atoi(name[strings.LastIndex(name, "-v")+2:])
	if err != nil {
		return 0
	}
	return version
}

// swapIn moves the upgraded database at path aside, and the copy into its
// place. Each database keeps its own side files: the upgraded one's go
// aside with it, and the copy's come back with the copy, so nothing a file
// had not yet folded in is lost and nothing is left lying about. When a
// move fails, the moves made are undone.
func swapIn(path, newest, aside string) error {
	var moves fileMoves
	if err := moves.move(path, aside); err != nil {
		return err
	}
	for _, suffix := range sideFiles {
		if err := moves.moveSide(path+suffix, aside+suffix); err != nil {
			return moves.undo(err)
		}
	}
	if err := moves.move(newest, path); err != nil {
		return moves.undo(err)
	}
	for _, suffix := range sideFiles {
		if err := moves.moveSide(newest+suffix, path+suffix); err != nil {
			return moves.undo(err)
		}
	}
	return nil
}

// fileMoves are the renames one undo has made, so that they can be undone.
type fileMoves struct {
	done []fileMove
}

// fileMove is one rename made.
type fileMove struct{ from, to string }

// move renames from to to, and remembers it to be undone.
func (m *fileMoves) move(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	m.done = append(m.done, fileMove{from, to})
	return nil
}

// moveSide is move for a side file, which need not be there: SQLite
// removes them when the database is closed cleanly.
func (m *fileMoves) moveSide(from, to string) error {
	if err := m.move(from, to); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// undo renames back the moves made, the last first, after cause stopped the
// undo. Its error says where every file is: back where it was, or, when
// putting it back failed too, where it was left.
func (m *fileMoves) undo(cause error) error {
	var stuck []error
	for _, move := range slices.Backward(m.done) {
		if err := os.Rename(move.to, move.from); err != nil {
			stuck = append(stuck, fmt.Errorf("%s is now at %s; putting it back failed: %w", move.from, move.to, err))
		}
	}
	if len(stuck) == 0 {
		return fmt.Errorf("could not put the copy in place (%w); every file was put back where it was, nothing was changed", cause)
	}
	return fmt.Errorf("could not put the copy in place, and putting the files back failed too; move them back by hand before starting quadit:\n%w",
		errors.Join(append([]error{cause}, stuck...)...))
}

// OpenAt is Open stopping at a schema version (0 = the newest), which
// stands in for an older binary.
func OpenAt(ctx context.Context, path string, upTo int) (*sqlstore.Store, error) {
	// WAL lets readers run while one writer writes. Write transactions take
	// the write lock when they begin, so two writers queue instead of one
	// failing halfway with "database is locked".
	params := url.Values{}
	params.Add("_pragma", "journal_mode(WAL)")
	params.Add("_pragma", "synchronous(NORMAL)")
	params.Add("_pragma", "foreign_keys(1)")
	params.Add("_pragma", "busy_timeout(10000)")
	params.Set("_txlock", "immediate")
	db, err := sql.Open("sqlite", fileURI(path, params.Encode()))
	if err != nil {
		return nil, fmt.Errorf("sqlite: %w", err)
	}
	st := sqlstore.New(db, sqlstore.SQLite)
	if err := st.Ping(ctx); err != nil {
		_ = db.Close() // the error that matters is the one above
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	// A version that cannot be read here is reported by MigrateTo, which
	// reads it again.
	if cur, latest, err := st.Pending(ctx); err == nil && cur > 0 && cur < latest {
		if err := copyBeforeUpgrade(ctx, st, path, cur, latest); err != nil {
			_ = db.Close() // the error that matters is the copy's
			return nil, err
		}
	}
	if err := st.MigrateTo(ctx, upTo); err != nil {
		_ = db.Close() // the error that matters is the migration's
		return nil, err
	}
	return st, nil
}

// copyBeforeUpgrade leaves a copy of the database as it was beside it, before
// an upgrade from version cur to latest changes the schema, unless one is
// there. Going back is: stop, put the copy in place, run the old binary.
func copyBeforeUpgrade(ctx context.Context, st *sqlstore.Store, path string, cur, latest int) error {
	snapshot := Before(path, latest)
	if _, err := os.Stat(snapshot); err == nil {
		return nil
	}
	if err := st.Exec(ctx, "VACUUM INTO '"+strings.ReplaceAll(snapshot, "'", "''")+"'"); err != nil {
		return fmt.Errorf("sqlite: could not copy the database before upgrading it (%w); nothing was changed", err)
	}
	fmt.Fprintf(os.Stderr, "quadit: upgrading the database from version %d to %d; a copy of it as it was is at %s\n", cur, latest, snapshot)
	return nil
}

// fileURI is the SQLite URI of the database file at path, with a query. The
// path is escaped, so a ?, # or % in a folder's name is part of the name.
func fileURI(path, query string) string {
	return "file:" + (&url.URL{Path: path}).EscapedPath() + "?" + query
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
	db, err := sql.Open("sqlite", fileURI(path, "mode=ro"))
	if err != nil {
		return err
	}
	defer db.Close() // read-only: nothing to lose
	var version, workspaces int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&version); err != nil || version == 0 {
		return fmt.Errorf("it has no schema of ours")
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces`).Scan(&workspaces); err != nil {
		return err
	}
	return nil
}
