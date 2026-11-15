// Whole tables out and back in, as column -> value maps, for
// backups that work across databases.

package sqlstore

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// Dump calls each with every row of a table as column -> value. Columns
// holding their zero value are left out.
func (s *Store) Dump(ctx context.Context, table string, each func(row map[string]any) error) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	rows, err := s.query(ctx, "SELECT "+m.cols+" FROM "+m.name)
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

// Load inserts rows produced by Dump (after a trip through JSON), all in one
// transaction.
func (s *Store) Load(ctx context.Context, table string, rows []map[string]any) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(r runner) error {
		for _, row := range rows {
			args, err := loadArgs(m, table, row)
			if err != nil {
				return err
			}
			if _, err := r.exec(ctx, "INSERT INTO "+m.name+" ("+m.cols+") VALUES ("+placeholders(len(args))+")", args...); err != nil {
				return fmt.Errorf("%s: %w", table, err)
			}
		}
		return nil
	})
}

// Overwrite sets the matching rows to what an archive row says, column by
// column. The columns named in keep are left as they are now: a row's place
// in the feed belongs to this database, not to the archive.
func (s *Store) Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...store.Cond) error {
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
	return s.inTx(ctx, func(r runner) error {
		whereSQL, whereArgs, err := (conn{runner: r}).where(m, where)
		if err != nil {
			return err
		}
		_, err = r.exec(ctx, "UPDATE "+m.name+" SET "+strings.Join(sets, ", ")+" WHERE "+whereSQL, append(vals, whereArgs...)...)
		return err
	})
}
