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
func Open(ctx context.Context, url string) (*sqlstore.Store, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("postgres: %w", err)
	}
	s := sqlstore.New(db, sqlstore.Postgres)
	if err := s.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("postgres: connect: %w", err)
	}
	if cur, latest, err := s.Pending(ctx); err == nil && cur > 0 && cur < latest {
		fmt.Fprintf(os.Stderr, "quadit: upgrading the database from version %d to %d. If you have no backup from before this start, "+
			"stop now and take one (quadit backup with the old binary, or pg_dump).\n", cur, latest)
	}
	if err := s.Migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	s.SetListen(func(ctx context.Context, each func(workspaceID string, seq int64)) error {
		return listen(ctx, url, each)
	})
	return s, nil
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
