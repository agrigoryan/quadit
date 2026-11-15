package sqlstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/database"
)

// Applied schema versions are recorded in two tables:
//
//	goose_db_version    goose's own; it decides what still has to run
//	schema_migrations   the one this code kept before it used goose
//
// The second is kept in step with the first, in the same transaction, so
// that a binary from before goose still reads the version a database is
// at: it refuses a schema newer than it knows, and opens the copy that
// "quadit upgrade --undo" puts back.
const (
	gooseTable = goose.DefaultTablename
	oldTable   = "schema_migrations"
)

// ledger is goose's record of applied versions, which also writes each
// version to the old table.
type ledger struct {
	database.StoreExtender // goose's table, in goose's own SQL for this database
	d                      Dialect
	names                  map[int64]string // version -> name, as the old table has it
}

var _ database.StoreExtender = (*ledger)(nil)

func newLedger(d Dialect, versions []schemaVersion) (*ledger, error) {
	own, err := gooseRecord(d)
	if err != nil {
		return nil, err
	}
	names := make(map[int64]string, len(versions))
	for _, v := range versions {
		names[int64(v.number)] = v.name
	}
	return &ledger{StoreExtender: own, d: d, names: names}, nil
}

// gooseRecord is goose's table alone, as goose reads and writes it.
func gooseRecord(d Dialect) (database.StoreExtender, error) {
	st, err := database.NewStore(d.goose, gooseTable)
	if err != nil {
		return nil, err
	}
	own, ok := st.(database.StoreExtender)
	if !ok {
		return nil, fmt.Errorf("goose's store for %s is a %T", d.Name, st)
	}
	return own, nil
}

// CreateVersionTable makes both tables. goose calls it once, on a database
// that has neither.
func (l *ledger) CreateVersionTable(ctx context.Context, db database.DBTxConn) error {
	if err := l.StoreExtender.CreateVersionTable(ctx, db); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, l.d.expand(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version {{INT}} PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at {{TS}} NOT NULL
	)`))
	return err
}

// Insert records a version as applied, in the transaction that applied it.
func (l *ledger) Insert(ctx context.Context, db database.DBTxConn, req database.InsertRequest) error {
	if err := l.StoreExtender.Insert(ctx, db, req); err != nil {
		return err
	}
	if req.Version == 0 {
		return nil // the row goose starts its table with; the old table has none
	}
	_, err := db.ExecContext(ctx, l.d.Rebind(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`),
		req.Version, l.names[req.Version], time.Now().UnixMilli())
	return err
}

// Delete forgets a version in both tables. Nothing here goes down a
// version; it is there because goose's record has it.
func (l *ledger) Delete(ctx context.Context, db database.DBTxConn, version int64) error {
	if err := l.StoreExtender.Delete(ctx, db, version); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, l.d.Rebind(`DELETE FROM schema_migrations WHERE version = ?`), version)
	return err
}

// hasTable reports whether the schema in use has a table of this name.
func hasTable(ctx context.Context, db database.DBTxConn, d Dialect, name string) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx, d.Rebind(d.hasTable), name).Scan(&n)
	return n > 0, err
}

// appliedVersion reads the schema version a database is at: from goose's
// table when it is there, else from the old one. A database with neither
// is at 0. It writes nothing.
func appliedVersion(ctx context.Context, db database.DBTxConn, d Dialect) (int64, error) {
	if kept, err := hasTable(ctx, db, d, gooseTable); err != nil {
		return 0, err
	} else if kept {
		return gooseVersion(ctx, db, d)
	}
	if old, err := hasTable(ctx, db, d, oldTable); err != nil || !old {
		return 0, err
	}
	return oldVersion(ctx, db)
}

func gooseVersion(ctx context.Context, db database.DBTxConn, d Dialect) (int64, error) {
	own, err := gooseRecord(d)
	if err != nil {
		return 0, err
	}
	v, err := own.GetLatestVersion(ctx, db)
	if errors.Is(err, database.ErrVersionNotFound) {
		return 0, nil
	}
	return v, err
}

func oldVersion(ctx context.Context, db database.DBTxConn) (int64, error) {
	var v int64
	err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}
