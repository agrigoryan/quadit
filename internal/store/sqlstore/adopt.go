// Taking over a database whose schema was put in place before
// this code used goose.

package sqlstore

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/pressly/goose/v3/database"
)

// adopt takes over a database whose schema was put in place before this
// code used goose: it has schema_migrations and no table of goose's. The
// versions it is at are written to goose's table as applied, and nothing
// is run; goose then applies only what is newer. On a new database, or one
// goose already keeps, adopt does nothing.
func (s *Store) adopt(ctx context.Context) error {
	if before, err := fromBeforeGoose(ctx, s.db, s.d); err != nil || !before {
		return err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		_ = conn.Close() // it only goes back to the pool: nothing is lost if that fails
	}()
	unlock, err := s.lockMigrations(ctx, conn)
	if err != nil {
		return err
	}
	defer unlock()
	// Under the lock, look again: another server may have done it meanwhile.
	if before, err := fromBeforeGoose(ctx, conn, s.d); err != nil || !before {
		return err
	}
	applied, err := oldVersion(ctx, conn)
	if err != nil {
		return err
	}
	return recordApplied(ctx, conn, s.d, applied)
}

// fromBeforeGoose reports whether a database has the old table of applied
// versions and not goose's.
func fromBeforeGoose(ctx context.Context, db database.DBTxConn, d Dialect) (bool, error) {
	if kept, err := hasTable(ctx, db, d, gooseTable); err != nil || kept {
		return false, err
	}
	return hasTable(ctx, db, d, oldTable)
}

// recordApplied makes goose's table and marks versions 1 to applied as
// applied, all or nothing. Version 0 is the row goose starts every table
// with.
func recordApplied(ctx context.Context, conn *sql.Conn, d Dialect, applied int64) error {
	own, err := gooseRecord(d)
	if err != nil {
		return err
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // after Commit it does nothing; before, the error that stopped us is the one returned
	if err := own.CreateVersionTable(ctx, tx); err != nil {
		return err
	}
	for v := int64(0); v <= applied; v++ {
		if err := own.Insert(ctx, tx, database.InsertRequest{Version: v}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// lockMigrations takes the database's migration lock on conn, the one
// goose holds while it migrates, and returns how to give it back. A
// database only one server uses has no lock.
func (s *Store) lockMigrations(ctx context.Context, conn *sql.Conn) (unlock func(), err error) {
	if s.d.migrationLock == nil {
		return func() {}, nil
	}
	l, err := s.d.migrationLock()
	if err != nil {
		return nil, err
	}
	if err := l.SessionLock(ctx, conn); err != nil {
		return nil, err
	}
	return func() {
		// The lock belongs to conn's session, which outlives conn.Close in
		// the pool: one not given back keeps other servers waiting.
		if err := l.SessionUnlock(context.WithoutCancel(ctx), conn); err != nil {
			slog.Warn("store: could not give back the migration lock", "err", err)
		}
	}, nil
}
