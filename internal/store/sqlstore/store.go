// Package sqlstore is the data layer for SQL databases. It holds the schema,
// the queries and the transaction rules once; the sqlite and postgres packages
// only open a connection and name their dialect.
package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// Store is a database handle plus the dialect it speaks.
type Store struct {
	conn // bound to no workspace
	db   *sql.DB
	d    Dialect
	// writer queues write transactions on a single-writer database.
	writer sync.Mutex
	// listen hears of writes made through other servers; nil when the
	// database cannot tell.
	listen func(ctx context.Context, each func(workspaceID string, seq int64)) error
}

var _ store.Store = (*Store)(nil)
var _ store.Tx = (*tx)(nil)

// New wraps an open database. Close closes it.
func New(db *sql.DB, d Dialect) *Store {
	return &Store{conn: conn{q: q{c: db, d: d}}, db: db, d: d}
}

// Dialect returns the name of the database kind, "sqlite" or "postgres".
func (s *Store) Dialect() string { return s.d.Name }

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks that the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// In returns a DB bound to one workspace.
func (s *Store) In(workspaceID string) store.DB {
	return conn{q: q{c: s.db, d: s.d}, ws: workspaceID}
}

// querier is what both a database and a transaction can do.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// FeedChannel is the Postgres notification channel on which a write says
// "this workspace's feed is now at N".
const FeedChannel = "quadit_feed"

// Listen calls each with every workspace whose feed moved, on whichever
// server the write happened, until ctx ends. Only a database that can tell
// other servers has one; the Postgres opener sets it.
func (s *Store) Listen(ctx context.Context, each func(workspaceID string, seq int64)) error {
	if s.listen == nil {
		return store.ErrNoListen
	}
	return s.listen(ctx, each)
}

// SetListen gives the store its way to hear of other servers' writes.
func (s *Store) SetListen(fn func(ctx context.Context, each func(workspaceID string, seq int64)) error) {
	s.listen = fn
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

// inTx runs fn in one transaction and commits when it returns nil.
func (s *Store) inTx(ctx context.Context, fn func(q) error) (err error) {
	if s.d.SingleWriter {
		s.writer.Lock()
		defer s.writer.Unlock()
	}
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = t.Rollback()
			panic(p)
		}
		if err != nil {
			if rbErr := t.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
				err = errors.Join(err, rbErr)
			}
		}
	}()
	if err = fn(q{c: t, d: s.d}); err != nil {
		return err
	}
	if err = t.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// Atomic runs fn in one transaction outside any workspace's sequence.
func (s *Store) Atomic(ctx context.Context, fn func(store.DB) error) error {
	return s.inTx(ctx, func(x q) error { return fn(conn{q: x}) })
}

// tx is one write to one workspace.
type tx struct {
	conn
	seq int64 // last number handed out
}

// Write runs fn in a transaction that holds the workspace's row lock from
// its first statement. On Postgres that lock is what makes writers to one
// workspace queue; on SQLite the write transaction already does. Either way
// event numbers are handed out in commit order, so a reader that has seen
// number N has seen everything before it.
func (s *Store) Write(ctx context.Context, workspaceID string, fn func(store.Tx) error) error {
	if !looksUUID(workspaceID) {
		return fmt.Errorf("workspace %q: %w", workspaceID, store.ErrNotFound)
	}
	return s.inTx(ctx, func(x q) error {
		var seq int64
		err := x.row(ctx, `UPDATE workspaces SET seq = seq WHERE id = ? AND deleted_at IS NULL RETURNING seq`, workspaceID).Scan(&seq)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("workspace %s: %w", workspaceID, store.ErrNotFound)
		}
		if err != nil {
			return err
		}
		t := &tx{conn: conn{q: x, ws: workspaceID}, seq: seq}
		if err := fn(t); err != nil {
			return err
		}
		if t.seq == seq {
			return nil
		}
		if _, err = x.exec(ctx, `UPDATE workspaces SET seq = ?, updated_at = ? WHERE id = ?`, t.seq, time.Now().UnixMilli(), workspaceID); err != nil {
			return err
		}
		if s.d.Name == "postgres" {
			// Tell every server sharing this database that the feed moved.
			// The database delivers it when, and only if, this write commits.
			_, err = x.exec(ctx, `SELECT pg_notify('`+FeedChannel+`', ?)`, workspaceID+":"+strconv.FormatInt(t.seq, 10))
		}
		return err
	})
}

func (t *tx) WorkspaceID() string { return t.ws }
func (t *tx) Seq() int64          { return t.seq }

func (t *tx) NextSeq() int64 {
	t.seq++
	return t.seq
}

func (t *tx) Emit(ctx context.Context, ev core.Event) error {
	if ev.Seq <= 0 || ev.Seq > t.seq {
		return fmt.Errorf("emit %s: seq %d was not handed out by this write", ev.Type, ev.Seq)
	}
	ev.WorkspaceID = t.ws
	return t.Insert(ctx, ev)
}
