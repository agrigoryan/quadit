// Package postgres opens a Postgres database for larger installs. Everything
// is in postgres.go: opening (with a copy made before an upgrade), undoing
// the last upgrade from that copy, and hearing other servers' writes; the
// data layer itself is package sqlstore.
package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver

	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// Open connects to the database at url (postgres://user:pass@host/db) and
// brings its schema up to date.
func Open(ctx context.Context, url string) (*sqlstore.Store, error) { return OpenAt(ctx, url, 0) }

// Before names the copy of a database made before it was upgraded to a
// schema version.
func Before(database string, version int) string {
	return fmt.Sprintf("%s_before_v%d", database, version)
}

// OpenAt is Open stopping at a schema version (0 = the newest), which
// stands in for an older binary.
func OpenAt(ctx context.Context, url string, upTo int) (*sqlstore.Store, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("postgres: %w", err)
	}
	st := sqlstore.New(db, sqlstore.Postgres)
	if err := st.Ping(ctx); err != nil {
		_ = db.Close() // the error that matters is the one above
		return nil, fmt.Errorf("postgres: connect: %w", err)
	}
	// An upgrade that changes the schema first leaves a copy of the whole
	// database as it was, beside it on the same server. Going back is: stop,
	// "quadit upgrade --undo", run the old binary. A version that cannot be
	// read here is reported by MigrateTo, which reads it again.
	if cur, latest, err := st.Pending(ctx); err == nil && cur > 0 && cur < latest && upTo == 0 {
		// The copy needs the database to itself for a moment. A connection
		// left open makes the copy fail, which is reported.
		_ = db.Close()
		name, cerr := copyDatabase(ctx, url, latest)
		if cerr != nil && os.Getenv("QUADIT_UPGRADE_WITHOUT_COPY") == "" {
			return nil, fmt.Errorf("postgres: could not copy the database before upgrading it from version %d to %d (%w); nothing was changed. "+
				"Stop every other program using it and give the role CREATEDB, or take a backup yourself and set QUADIT_UPGRADE_WITHOUT_COPY=1", cur, latest, cerr)
		}
		if cerr == nil {
			fmt.Fprintf(os.Stderr, "quadit: upgrading the database from version %d to %d; a copy of it as it was is the database %q\n", cur, latest, name)
		}
		if db, err = sql.Open("pgx", url); err != nil {
			return nil, fmt.Errorf("postgres: %w", err)
		}
		st = sqlstore.New(db, sqlstore.Postgres)
	}
	if err := st.MigrateTo(ctx, upTo); err != nil {
		_ = db.Close() // the error that matters is the migration's
		return nil, err
	}
	st.SetListen(func(ctx context.Context, each func(workspaceID string, seq int64)) error {
		return listen(ctx, url, each)
	})
	return st, nil
}

// maintenance connects to the server's own "postgres" database, from where
// other databases can be copied and renamed, and returns the name of the
// database url points at.
func maintenance(ctx context.Context, url string) (*pgx.Conn, string, error) {
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, "", err
	}
	name := cfg.Database
	cfg.Database = "postgres"
	cfg.RuntimeParams = map[string]string{}
	admin, err := pgx.ConnectConfig(ctx, cfg)
	return admin, name, err
}

// closeConn ends a connection of ours, even when ctx has ended.
func closeConn(ctx context.Context, conn *pgx.Conn) {
	_ = conn.Close(context.WithoutCancel(ctx)) // the work on it is done, or failed with an error of its own
}

// quote makes a database name safe to put in a statement.
func quote(name string) string { return pgx.Identifier{name}.Sanitize() }

// copyDatabase makes an exact copy of the database beside it, named for
// the schema version about to be applied. One that is already there stays.
func copyDatabase(ctx context.Context, url string, version int) (string, error) {
	admin, name, err := maintenance(ctx, url)
	if err != nil {
		return "", err
	}
	defer closeConn(ctx, admin)
	copyName := Before(name, version)
	var exists bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, copyName).Scan(&exists); err != nil {
		return "", err
	}
	if exists {
		return copyName, nil
	}
	_, err = admin.Exec(ctx, "CREATE DATABASE "+quote(copyName)+" TEMPLATE "+quote(name))
	return copyName, err
}

// UndoUpgrade puts back the copy made before the last upgrade: the upgraded
// database is kept under another name, and the copy takes its place. The
// older binary then runs as before.
func UndoUpgrade(ctx context.Context, url string) (from, to string, err error) {
	admin, name, err := maintenance(ctx, url)
	if err != nil {
		return "", "", err
	}
	defer closeConn(ctx, admin)
	newest, version, err := newestCopy(ctx, admin, name)
	if err != nil {
		return "", "", err
	}
	if newest == "" {
		return "", "", fmt.Errorf("there is no copy of %s from before an upgrade", name)
	}
	aside := fmt.Sprintf("%s_after_v%d", name, version)
	if err := rename(ctx, admin, name, aside); err != nil {
		return "", "", fmt.Errorf("could not move the upgraded database aside (is something still using it?): %w", err)
	}
	if err := rename(ctx, admin, newest, name); err != nil {
		return "", "", moveBack(ctx, admin, name, aside, newest, err)
	}
	return newest, aside, nil
}

// newestCopy finds the copy made before the last upgrade: of the databases
// "<name>_before_vN", the one with the largest N, and N. It returns "" when
// there is none.
func newestCopy(ctx context.Context, admin *pgx.Conn, name string) (string, int, error) {
	rows, err := admin.Query(ctx, `SELECT datname FROM pg_database WHERE datname LIKE $1`, strings.ReplaceAll(name, "_", `\_`)+`\_before\_v%`)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	newest, version := "", -1
	for rows.Next() {
		var database string
		if err := rows.Scan(&database); err != nil {
			return "", 0, err
		}
		// A name that does not end in a number is not a copy of ours.
		if v, err := strconv.Atoi(database[strings.LastIndex(database, "_v")+2:]); err == nil && v > version {
			newest, version = database, v
		}
	}
	return newest, version, rows.Err()
}

// rename renames a database.
func rename(ctx context.Context, admin *pgx.Conn, from, to string) error {
	_, err := admin.Exec(ctx, "ALTER DATABASE "+quote(from)+" RENAME TO "+quote(to))
	return err
}

// moveBack gives the upgraded database, moved aside, its name back after
// the copy could not take it (cause). Its error says where each database
// now is. It runs even when ctx has ended, which may be why the copy could
// not move.
func moveBack(ctx context.Context, admin *pgx.Conn, name, aside, newest string, cause error) error {
	if err := rename(context.WithoutCancel(ctx), admin, aside, name); err != nil {
		return fmt.Errorf("could not put %s in place of %s, nor give the upgraded database its name back: "+
			"there is now no database %s; the upgraded one is %s, and the copy is still %s:\n%w",
			newest, name, name, aside, newest, errors.Join(cause, err))
	}
	return fmt.Errorf("could not put %s in place of %s (is something using it?); the upgraded database is %s again, nothing was changed: %w",
		newest, name, name, cause)
}

// listen holds one connection that hears every server's "the feed moved",
// and passes each on. It returns when the connection breaks or ctx ends;
// the caller connects again.
func listen(ctx context.Context, url string, each func(workspaceID string, seq int64)) error {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer closeConn(ctx, conn)
	if _, err := conn.Exec(ctx, "LISTEN "+sqlstore.FeedChannel); err != nil {
		return err
	}
	for {
		note, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if note.Payload == "poke" {
			each("", -1) // no feed moved: wake everyone to look again
			continue
		}
		// A payload that is not "<workspace>:<seq>" is not ours: skip it.
		if workspaceID, seq, ok := strings.Cut(note.Payload, ":"); ok {
			if n, err := strconv.ParseInt(seq, 10, 64); err == nil {
				each(workspaceID, n)
			}
		}
	}
}
