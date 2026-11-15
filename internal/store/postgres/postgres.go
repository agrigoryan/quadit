// Package postgres opens a Postgres database for larger installs.
package postgres

import (
	"context"
	"database/sql"
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
	s := sqlstore.New(db, sqlstore.Postgres)
	if err := s.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("postgres: connect: %w", err)
	}
	// An upgrade that changes the schema first leaves a copy of the whole
	// database as it was, beside it on the same server. Going back is: stop,
	// "quadit upgrade --undo", run the old binary.
	if cur, latest, err := s.Pending(ctx); err == nil && cur > 0 && cur < latest && upTo == 0 {
		db.Close() // the copy needs the database to itself for a moment
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
		s = sqlstore.New(db, sqlstore.Postgres)
	}
	if err := s.MigrateTo(ctx, upTo); err != nil {
		db.Close()
		return nil, err
	}
	s.SetListen(func(ctx context.Context, each func(workspaceID string, seq int64)) error {
		return listen(ctx, url, each)
	})
	return s, nil
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
	c, err := pgx.ConnectConfig(ctx, cfg)
	return c, name, err
}

func quote(name string) string { return pgx.Identifier{name}.Sanitize() }

// copyDatabase makes an exact copy of the database beside it, named for
// the schema version about to be applied. One that is already there stays.
func copyDatabase(ctx context.Context, url string, version int) (string, error) {
	c, name, err := maintenance(ctx, url)
	if err != nil {
		return "", err
	}
	defer c.Close(context.Background())
	copyName := Before(name, version)
	var exists bool
	if err := c.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, copyName).Scan(&exists); err != nil {
		return "", err
	}
	if exists {
		return copyName, nil
	}
	_, err = c.Exec(ctx, "CREATE DATABASE "+quote(copyName)+" TEMPLATE "+quote(name))
	return copyName, err
}

// UndoUpgrade puts back the copy made before the last upgrade: the upgraded
// database is kept under another name, and the copy takes its place. The
// older binary then runs as before.
func UndoUpgrade(ctx context.Context, url string) (from, to string, err error) {
	c, name, err := maintenance(ctx, url)
	if err != nil {
		return "", "", err
	}
	defer c.Close(context.Background())
	rows, err := c.Query(ctx, `SELECT datname FROM pg_database WHERE datname LIKE $1`, strings.ReplaceAll(name, "_", `\_`)+`\_before\_v%`)
	if err != nil {
		return "", "", err
	}
	newest, version := "", -1
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return "", "", err
		}
		if v, err := strconv.Atoi(d[strings.LastIndex(d, "_v")+2:]); err == nil && v > version {
			newest, version = d, v
		}
	}
	rows.Close()
	if newest == "" {
		return "", "", fmt.Errorf("there is no copy of %s from before an upgrade", name)
	}
	aside := fmt.Sprintf("%s_after_v%d", name, version)
	if _, err := c.Exec(ctx, "ALTER DATABASE "+quote(name)+" RENAME TO "+quote(aside)); err != nil {
		return "", "", fmt.Errorf("could not move the upgraded database aside (is something still using it?): %w", err)
	}
	if _, err := c.Exec(ctx, "ALTER DATABASE "+quote(newest)+" RENAME TO "+quote(name)); err != nil {
		c.Exec(ctx, "ALTER DATABASE "+quote(aside)+" RENAME TO "+quote(name))
		return "", "", err
	}
	return newest, aside, nil
}

// listen holds one connection that hears every server's "the feed moved",
// and passes each on. It returns when the connection breaks or ctx ends;
// the caller connects again.
func listen(ctx context.Context, url string, each func(workspaceID string, seq int64)) error {
	c, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer c.Close(context.Background())
	if _, err := c.Exec(ctx, "LISTEN "+sqlstore.FeedChannel); err != nil {
		return err
	}
	for {
		n, err := c.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if ws, seq, ok := strings.Cut(n.Payload, ":"); ok {
			if v, err := strconv.ParseInt(seq, 10, 64); err == nil {
				each(ws, v)
			}
		}
	}
}
