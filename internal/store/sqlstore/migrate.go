package sqlstore

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// A migration is one schema version. Its SQL is the shared file followed by
// the file for this dialect, when there is one:
//
//	0001_init.sql            every database, with {{TYPE}} macros
//	0001_init.sqlite.sql     SQLite only (for example full-text tables)
//	0001_init.postgres.sql   Postgres only
type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations(d Dialect) ([]migration, error) {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	byVersion := map[int]*migration{}
	// Within a version the shared file runs before the dialect's own file.
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Slice(names, func(i, j int) bool {
		si, sj := isShared(names[i]), isShared(names[j])
		vi, vj := names[i][:4], names[j][:4]
		if vi != vj {
			return vi < vj
		}
		if si != sj {
			return si
		}
		return names[i] < names[j]
	})
	for _, name := range names {
		base := strings.TrimSuffix(name, ".sql")
		parts := strings.Split(base, ".")
		if len(parts) == 2 && parts[1] != d.Name {
			continue // another dialect's file
		}
		if len(parts) > 2 || len(parts[0]) < 6 || parts[0][4] != '_' {
			return nil, fmt.Errorf("migration %q: want NNNN_name[.dialect].sql", name)
		}
		v, err := strconv.Atoi(parts[0][:4])
		if err != nil {
			return nil, fmt.Errorf("migration %q: bad version: %w", name, err)
		}
		body, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		m := byVersion[v]
		if m == nil {
			m = &migration{version: v, name: parts[0][5:]}
			byVersion[v] = m
		}
		m.sql += d.expand(string(body)) + "\n"
	}
	out := make([]migration, 0, len(byVersion))
	for _, m := range byVersion {
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i, m := range out {
		if m.version != i+1 {
			return nil, fmt.Errorf("migrations: version %d missing", i+1)
		}
	}
	return out, nil
}

func isShared(name string) bool {
	return strings.Count(name, ".") == 1
}

// Migrate brings the schema up to date. Each version runs in its own
// transaction and is recorded, so a failed upgrade leaves the last good
// version in place.
func (s *Store) Migrate(ctx context.Context) error {
	migs, err := loadMigrations(s.d)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, s.d.expand(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version {{INT}} PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at {{TS}} NOT NULL
	)`)); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	var current int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if current > len(migs) {
		return fmt.Errorf("migrate: database is at version %d, this binary knows %d: use a newer binary", current, len(migs))
	}
	for _, m := range migs[current:] {
		if err := s.applyMigration(ctx, m); err != nil {
			return fmt.Errorf("migrate %04d_%s: %w", m.version, m.name, err)
		}
	}
	return nil
}

func (s *Store) applyMigration(ctx context.Context, m migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range splitStatements(m.sql) {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("%w\nstatement: %s", err, firstLine(stmt))
		}
	}
	if _, err := tx.ExecContext(ctx, s.d.Rebind(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`),
		m.version, m.name, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

// SchemaVersion returns the applied schema version.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}

// splitStatements cuts a migration into statements at semicolons that end a
// line. Comment-only lines are dropped. Migrations keep to plain DDL, so no
// statement contains a semicolon at a line end inside a string or body.
func splitStatements(sqlText string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteByte('\n')
		if strings.HasSuffix(trimmed, ";") {
			out = append(out, strings.TrimSpace(cur.String()))
			cur.Reset()
		}
	}
	if rest := strings.TrimSpace(cur.String()); rest != "" {
		out = append(out, rest)
	}
	return out
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
