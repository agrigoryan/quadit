// Package sqlstore is the data layer for SQL databases. It holds the schema,
// the queries and the transaction rules once; the sqlite and postgres packages
// only open a connection and name their dialect.
//
// The files:
//
//	store.go            Store: the handle, transactions, the workspace write and its event numbers
//	record.go           the row mapper (structs <-> columns) and the generic operations of store.DB
//	clause.go           the WHERE builder and the placeholder helpers
//	queries.go          the task and event lists: task filters, keyset paging, the feed
//	search.go           full-text search; search_sqlite.go and search_postgres.go hold each index
//	dump.go             whole tables out and in, for backups
//	notify.go           telling other servers that a feed moved (Postgres)
//	dialect.go          what differs between the databases
//	migrate.go          bringing the schema up to date with goose
//	migration_files.go  the migration files as goose reads them
//	ledger.go           the record of applied schema versions, goose's and the older one
//	adopt.go            taking over a database migrated before goose
//
// docs/store.md tells how the migrations work, and compares the mapper with
// the query libraries considered in its place.
package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// Store is a database handle plus the dialect it speaks.
type Store struct {
	conn // bound to no workspace
	db   *sql.DB
	d    Dialect // the dialect the database speaks
	// writer queues write transactions on a single-writer database.
	writer sync.Mutex
	// listen hears of writes made through other servers; nil when the
	// database cannot tell.
	listen func(ctx context.Context, each func(workspaceID string, seq int64)) error
}

var _ store.Store = (*Store)(nil)
var _ store.Tx = (*writeTx)(nil)

// New wraps an open database. Close closes it.
func New(db *sql.DB, d Dialect) *Store {
	return &Store{conn: conn{runner: runner{handle: db, dialect: d}}, db: db, d: d}
}

// Dialect returns the name of the database kind, "sqlite" or "postgres".
func (s *Store) Dialect() string { return s.d.Name }

// Close closes the database: queries already under way finish, and any
// later one fails.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks that the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// In returns a DB bound to one workspace.
func (s *Store) In(workspaceID string) store.DB {
	return conn{runner: runner{handle: s.db, dialect: s.d}, workspaceID: workspaceID}
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

// Poke tells every server sharing the database to wake its waiters with no
// news in the feed. It does nothing on a database only one server uses.
func (s *Store) Poke(ctx context.Context) error {
	if s.d.notify == nil {
		return nil
	}
	return s.d.notify.poke(ctx, s.db)
}

// SetListen gives the store its way to hear of other servers' writes.
func (s *Store) SetListen(fn func(ctx context.Context, each func(workspaceID string, seq int64)) error) {
	s.listen = fn
}

// runner runs statements on a database or on a transaction (its handle),
// rebinding their "?" placeholders to the dialect's on the way.
type runner struct {
	handle  querier // a *sql.DB or a *sql.Tx
	dialect Dialect
}

func (r runner) exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return r.handle.ExecContext(ctx, r.dialect.Rebind(query), args...)
}

func (r runner) query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return r.handle.QueryContext(ctx, r.dialect.Rebind(query), args...)
}

func (r runner) row(ctx context.Context, query string, args ...any) *sql.Row {
	return r.handle.QueryRowContext(ctx, r.dialect.Rebind(query), args...)
}

// inTx runs fn in one transaction and commits when it returns nil. On a
// single-writer database it first waits for the write before it to end.
// When fn fails or panics, the transaction is rolled back.
func (s *Store) inTx(ctx context.Context, fn func(runner) error) (err error) {
	if s.d.SingleWriter {
		s.writer.Lock()
		defer s.writer.Unlock()
	}
	sqlTx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = sqlTx.Rollback() // the panic goes on up, and is what is worth reporting
			panic(p)
		}
		if err != nil {
			if rbErr := sqlTx.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
				err = errors.Join(err, rbErr)
			}
		}
	}()
	if err = fn(runner{handle: sqlTx, dialect: s.d}); err != nil {
		return err
	}
	if err = sqlTx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// Atomic runs fn in one transaction outside any workspace's sequence.
func (s *Store) Atomic(ctx context.Context, fn func(store.DB) error) error {
	return s.inTx(ctx, func(r runner) error { return fn(conn{runner: r}) })
}

// writeTx is the store.Tx of one write to one workspace: a conn bound to
// it, in the write's transaction, and the workspace's event numbers.
type writeTx struct {
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
	return s.inTx(ctx, func(r runner) error {
		var seq int64
		err := r.row(ctx, `UPDATE workspaces SET seq = seq WHERE id = ? AND deleted_at IS NULL RETURNING seq`, workspaceID).Scan(&seq)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("workspace %s: %w", workspaceID, store.ErrNotFound)
		}
		if err != nil {
			return err
		}
		write := &writeTx{conn: conn{runner: r, workspaceID: workspaceID}, seq: seq}
		if err := fn(write); err != nil {
			return err
		}
		if write.seq == seq {
			return nil
		}
		if _, err = r.exec(ctx, `UPDATE workspaces SET seq = ?, updated_at = ? WHERE id = ?`, write.seq, time.Now().UnixMilli(), workspaceID); err != nil {
			return err
		}
		if s.d.notify != nil {
			// Tell every server sharing this database that the feed moved.
			// The database delivers it when, and only if, this write commits.
			err = s.d.notify.feedMoved(ctx, r, workspaceID, write.seq)
		}
		return err
	})
}

// WorkspaceID is the workspace the write is to.
func (tx *writeTx) WorkspaceID() string { return tx.workspaceID }

// Seq is the last event number handed out.
func (tx *writeTx) Seq() int64 { return tx.seq }

// NextSeq hands out the next event number.
func (tx *writeTx) NextSeq() int64 {
	tx.seq++
	return tx.seq
}

// Emit stores an event numbered by NextSeq in this write.
func (tx *writeTx) Emit(ctx context.Context, ev core.Event) error {
	if ev.Seq <= 0 || ev.Seq > tx.seq {
		return fmt.Errorf("emit %s: seq %d was not handed out by this write", ev.Type, ev.Seq)
	}
	ev.WorkspaceID = tx.workspaceID
	return tx.Insert(ctx, ev)
}
