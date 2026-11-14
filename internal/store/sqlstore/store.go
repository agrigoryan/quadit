// Package sqlstore is the data layer for SQL databases. It holds the schema,
// the queries and the transaction rules once; the sqlite and postgres packages
// only open a connection and name their dialect.
package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
)

// Store is a database handle plus the dialect it speaks.
type Store struct {
	db *sql.DB
	d  Dialect
	// writer queues write transactions on a single-writer database.
	writer sync.Mutex
}

// New wraps an open database. The caller keeps ownership of nothing: Close
// closes the database.
func New(db *sql.DB, d Dialect) *Store {
	return &Store{db: db, d: d}
}

// Dialect returns the name of the database kind, "sqlite" or "postgres".
func (s *Store) Dialect() string { return s.d.Name }

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks that the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// querier is what both a database and a transaction can do.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// q runs rebound queries against a database or a transaction.
type q struct {
	c querier
	d Dialect
}

func (x q) exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return x.c.ExecContext(ctx, x.d.Rebind(query), args...)
}

func (x q) query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return x.c.QueryContext(ctx, x.d.Rebind(query), args...)
}

func (x q) row(ctx context.Context, query string, args ...any) *sql.Row {
	return x.c.QueryRowContext(ctx, x.d.Rebind(query), args...)
}

func (s *Store) read() q { return q{c: s.db, d: s.d} }

// inTx runs fn in one transaction and commits when it returns nil.
func (s *Store) inTx(ctx context.Context, fn func(q) error) (err error) {
	if s.d.SingleWriter {
		s.writer.Lock()
		defer s.writer.Unlock()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
		if err != nil {
			if rbErr := tx.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
				err = errors.Join(err, rbErr)
			}
		}
	}()
	if err = fn(q{c: tx, d: s.d}); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}
