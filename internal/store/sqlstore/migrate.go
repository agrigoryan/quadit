package sqlstore

import (
	"context"
	"fmt"

	"github.com/pressly/goose/v3"
)

// Migrate brings the schema up to date. goose runs each version in its own
// transaction and records it there, so a failed upgrade leaves the last
// good version in place; on a database several servers share it holds a
// lock meanwhile, so servers starting together take turns.
func (s *Store) Migrate(ctx context.Context) error { return s.MigrateTo(ctx, 0) }

// MigrateTo brings the schema up to a version, or to the newest when upTo
// is 0. Stopping short stands in for an older binary, to try an upgrade.
func (s *Store) MigrateTo(ctx context.Context, upTo int) error {
	current, latest, err := s.Pending(ctx)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	target := latest
	if upTo > 0 && upTo < latest {
		target = upTo
	}
	if current > target {
		if upTo > 0 {
			return nil
		}
		return fmt.Errorf("migrate: database is at version %d, this binary knows %d: use a newer binary", current, latest)
	}
	if err := s.adopt(ctx); err != nil {
		return fmt.Errorf("migrate: taking over the record of applied versions: %w", err)
	}
	runner, err := s.migrator()
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if _, err := runner.UpTo(ctx, int64(target)); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// migrator is goose over this database: the schema files as goose reads
// them, the record of applied versions, and the lock.
func (s *Store) migrator(more ...goose.ProviderOption) (*goose.Provider, error) {
	files, versions, err := gooseFiles(s.d)
	if err != nil {
		return nil, err
	}
	record, err := newLedger(s.d, versions)
	if err != nil {
		return nil, err
	}
	// goose.DialectCustom: the record is ours to give, and it is goose's
	// own for this database with the old table kept beside it.
	opts := []goose.ProviderOption{goose.WithStore(record), goose.WithDisableGlobalRegistry(true)}
	if s.d.migrationLock != nil {
		l, err := s.d.migrationLock()
		if err != nil {
			return nil, err
		}
		opts = append(opts, goose.WithSessionLocker(l))
	}
	return goose.NewProvider(goose.DialectCustom, s.db, files, append(opts, more...)...)
}

// Pending reports the schema version the database is at and the one this
// binary brings it to. A fresh database is at 0. It writes nothing.
func (s *Store) Pending(ctx context.Context) (current, latest int, err error) {
	versions, err := schemaVersions(s.d)
	if err != nil {
		return 0, 0, err
	}
	current, err = s.SchemaVersion(ctx)
	return current, len(versions), err
}

// SchemaVersion returns the applied schema version.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	v, err := appliedVersion(ctx, s.db, s.d)
	return int(v), err
}

// Exec runs one statement outside the data layer, for the few things that
// are about the database file itself.
func (s *Store) Exec(ctx context.Context, query string) error {
	_, err := s.db.ExecContext(ctx, query)
	return err
}
