// Whole tables out and back in, as column -> value maps, for
// backups that work across databases: out from one moment of the
// database (Snapshot), in all at once (Restore).

package sqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// Snapshot calls fn with the database as it stood at one moment: a
// transaction that only reads, at repeatable read. On Postgres that is a
// snapshot taken at its first statement; on SQLite in WAL mode a read
// transaction sees the database as it was at its first read, and does not
// stop writers (a read-only transaction begins deferred, not immediate).
func (s *Store) Snapshot(ctx context.Context, fn func(store.Snapshot) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	err = fn(conn{runner: runner{handle: tx, dialect: s.d}})
	// Nothing was written: ending the transaction only lets go of the
	// moment it held.
	if rbErr := tx.Rollback(); err == nil && !errors.Is(rbErr, sql.ErrTxDone) {
		err = rbErr
	}
	return err
}

// Dump calls each with every row of a table as column -> value. Columns
// holding their zero value are left out.
func (c conn) Dump(ctx context.Context, table string, each func(row map[string]any) error) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	rows, err := c.query(ctx, "SELECT "+m.cols+" FROM "+m.name)
	if err != nil {
		return err
	}
	defer rows.Close() // rows.Err below reports what went wrong while reading
	for rows.Next() {
		record := reflect.New(m.table.Type).Elem()
		if err := rows.Scan(m.dests(record)...); err != nil {
			return err
		}
		row := make(map[string]any, len(m.fields))
		for i := range m.fields {
			f := &m.fields[i]
			v := record.Field(f.idx)
			if v.IsZero() {
				continue
			}
			row[f.col] = v.Interface()
		}
		if err := each(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

// loadArgs turns a row from an archive into the values to store, one per
// column of the table, in column order. A column the row leaves out, or
// holds null in, gets the zero value, which a NOT NULL column needs.
func loadArgs(m *meta, table string, row map[string]any) ([]any, error) {
	args := make([]any, len(m.fields))
	for i := range m.fields {
		f := &m.fields[i]
		zero := reflect.Zero(m.table.Type.Field(f.idx).Type).Interface()
		val, ok := row[f.col]
		if !ok || val == nil {
			val = zero
		}
		if f.json {
			args[i] = jsonArg(val)
			continue
		}
		arg, err := toDB(f, reflect.ValueOf(val))
		if err != nil {
			return nil, fmt.Errorf("%s.%s: %w", table, f.col, err)
		}
		if arg == nil && !f.null {
			arg = zero
		}
		args[i] = arg
	}
	return args, nil
}

// jsonArg is the value of a JSON column from an archive row. The value came
// through JSON, so it is written back as JSON; an empty one, or one that
// cannot be (it was just read from JSON), is NULL.
func jsonArg(val any) any {
	b, err := json.Marshal(val)
	if err != nil || string(b) == "null" || reflect.ValueOf(val).IsZero() {
		return nil
	}
	return string(b)
}

// Restore runs fn in one transaction whose Loader loads an archive's rows
// and brings them up to this schema: all of it is stored, or none.
func (s *Store) Restore(ctx context.Context, fn func(store.Loader) error) error {
	return s.inTx(ctx, func(r runner) error { return fn(conn{runner: r}) })
}

// Load inserts rows produced by Dump (after a trip through JSON), all in one
// transaction.
func (s *Store) Load(ctx context.Context, table string, rows []map[string]any) error {
	return s.Restore(ctx, func(l store.Loader) error { return l.Load(ctx, table, rows) })
}

// Load inserts rows produced by Dump. In a conn bound to a workspace, a
// row of a workspace table is put in that workspace whatever it says.
func (c conn) Load(ctx context.Context, table string, rows []map[string]any) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	for _, row := range rows {
		args, err := loadArgs(m, table, row)
		if err != nil {
			return err
		}
		if c.workspaceID != "" && !m.table.Global {
			for i := range m.fields {
				if m.fields[i].col == "workspace_id" {
					args[i] = c.workspaceID
				}
			}
		}
		if _, err := c.exec(ctx, "INSERT INTO "+m.name+" ("+m.cols+") VALUES ("+placeholders(len(args))+")", args...); err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
	}
	return nil
}

// Overwrite sets the matching rows to what an archive row says, column by
// column. The columns named in keep are left as they are now: a row's place
// in the feed belongs to this database, not to the archive.
func (s *Store) Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...store.Cond) error {
	return s.inTx(ctx, func(r runner) error { return conn{runner: r}.Overwrite(ctx, table, row, keep, where...) })
}

// Overwrite is Store.Overwrite on this conn: in a conn bound to a
// workspace, only that workspace's rows match.
func (c conn) Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...store.Cond) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	args, err := loadArgs(m, table, row)
	if err != nil {
		return err
	}
	var sets []string
	var vals []any
	for i := range m.fields {
		col := m.fields[i].col
		if col == "id" || col == "workspace_id" || slices.Contains(keep, col) {
			continue
		}
		sets = append(sets, ident(col)+" = ?")
		vals = append(vals, args[i])
	}
	whereSQL, whereArgs, err := c.where(m, where)
	if err != nil {
		return err
	}
	_, err = c.exec(ctx, "UPDATE "+m.name+" SET "+strings.Join(sets, ", ")+" WHERE "+whereSQL, append(vals, whereArgs...)...)
	return err
}
