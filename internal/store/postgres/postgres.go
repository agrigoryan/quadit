// Package postgres opens a Postgres database for larger installs.
package postgres

import (
	"context"
	"database/sql"
	"fmt"

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
	if err := s.Migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
