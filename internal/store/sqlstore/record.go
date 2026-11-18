// The row mapper, which turns the structs of package core into
// columns and back, and the generic operations of store.DB built on it.
//
// A row struct is registered with its table in store/tables.go. Each field
// tagged `db:"col"` is the column col; `db:"col,null"` stores the field's
// zero value ("" or 0) as NULL; `db:"col,json"` stores the field as JSON
// text (JSONB on Postgres), and its zero value as NULL. Reading, NULL is
// always the zero value. A field without a tag, or tagged "-", is not
// stored. metaOf reads the tags once per type, checks that every name is
// plain (so that quoting it with ident is safe) and keeps the result.
//
// A column named id or ending in _id holds a UUID, unless textIDs says
// otherwise. Postgres refuses to compare a UUID column with text that is
// not one, so a condition on such a column with a value that cannot be an
// id selects nothing instead of failing: "=" becomes "1 = 0" and a list
// drops the value.
//
// conn.where turns conditions (store.Cond) into a WHERE: each column is
// checked against the table's, each value is a placeholder. meta.order
// turns a Q's Order into an ORDER BY of the table's own columns. Statements
// are written with "?" and rebound to the dialect's placeholders as they
// run (runner). Workspace scoping is added here, in one place: a conn bound
// to a workspace puts "workspace_id = ?" first in every WHERE on a table
// that is not Global, and Insert and Upsert write that workspace into the
// row's workspace_id, whatever the row says.

package sqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"sync"

	"github.com/agrigoryan/quadit/internal/store"
)

// field is one column of a row struct.
type field struct {
	idx  int    // the struct field's index
	col  string // the column's name, unquoted
	null bool   // the zero value is stored as NULL
	json bool   // stored as JSON
	isID bool   // holds a UUID
}

// meta is what the mapper knows about one row type: its table and columns.
type meta struct {
	table  *store.Table
	name   string // the table's name, quoted
	fields []field
	byCol  map[string]*field
	cols   string // every column, quoted, in field order: `"a", "b", "c"`
}

var metaCache sync.Map // reflect.Type -> *meta

// metaOf returns the meta of a registered row type, reading its tags the
// first time it is asked for.
func metaOf(t reflect.Type) (*meta, error) {
	if m, ok := metaCache.Load(t); ok {
		return m.(*meta), nil
	}
	table, ok := store.TableOf(t)
	if !ok {
		return nil, fmt.Errorf("store: %s is not a registered row type", t)
	}
	if !plainName(table.Name) {
		return nil, fmt.Errorf("store: table name %q is not a plain name", table.Name)
	}
	m := &meta{table: table, name: ident(table.Name), byCol: map[string]*field{}}
	var cols []string
	for i := range t.NumField() {
		tag := t.Field(i).Tag.Get("db")
		if tag == "" || tag == "-" {
			continue
		}
		parts := strings.Split(tag, ",")
		if !plainName(parts[0]) {
			return nil, fmt.Errorf("store: %s column %q is not a plain name", table.Name, parts[0])
		}
		f := field{idx: i, col: parts[0]}
		for _, opt := range parts[1:] {
			switch opt {
			case "null":
				f.null = true
			case "json":
				f.json = true
			}
		}
		f.isID = (f.col == "id" || strings.HasSuffix(f.col, "_id")) && !textIDs[table.Name+"."+f.col]
		m.fields = append(m.fields, f)
		cols = append(cols, ident(f.col))
	}
	for i := range m.fields {
		m.byCol[m.fields[i].col] = &m.fields[i]
	}
	m.cols = strings.Join(cols, ", ")
	metaCache.Store(t, m)
	return m, nil
}

// textIDs are the *_id columns that do not hold UUIDs.
var textIDs = map[string]bool{"oauth_clients.id": true, "audit_log.target_id": true, "api_tokens.client_id": true}

// metaNamed returns the meta of a registered table, by its name.
func metaNamed(table string) (*meta, error) {
	tb, ok := store.TableNamed(table)
	if !ok {
		return nil, fmt.Errorf("store: unknown table %q", table)
	}
	return metaOf(tb.Type)
}

// plainName tells whether s can name a table or a column: lowercase
// letters, digits and underscores, not starting with a digit.
func plainName(s string) bool {
	if s == "" || isDigit(s[0]) {
		return false
	}
	for i := range len(s) {
		if !isDigit(s[i]) && !isLower(s[i]) && s[i] != '_' {
			return false
		}
	}
	return true
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isLower(c byte) bool { return c >= 'a' && c <= 'z' }

// isHexDigit accepts either case, as Postgres writes UUIDs in lowercase and
// a caller may not.
func isHexDigit(c byte) bool { return isDigit(c) || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }

// ident quotes a table or column name the way both databases read it. Only
// plain names reach it (metaOf and column check them), so it cannot be
// broken out of; quoted, a name that is a keyword somewhere (key, rank,
// order) is still a name.
func ident(name string) string { return `"` + name + `"` }

// column returns a column of the table, quoted, or an error when the table
// has no such column.
func (m *meta) column(name string) (string, error) {
	if _, ok := m.byCol[name]; !ok {
		return "", fmt.Errorf("store: table %s has no column %q", m.table.Name, name)
	}
	return ident(name), nil
}

// uuidLength is the length of a UUID in text: 32 hex digits and 4 dashes.
const uuidLength = 36

// looksUUID tells whether s is a UUID in text, 8-4-4-4-12 hex digits.
func looksUUID(s string) bool {
	if len(s) != uuidLength {
		return false
	}
	for i := range len(s) {
		switch i {
		case 8, 13, 18, 23:
			if s[i] != '-' {
				return false
			}
		default:
			if !isHexDigit(s[i]) {
				return false
			}
		}
	}
	return true
}

// toDB turns a Go value into what is stored in f's column: nil for NULL
// (see the null rule above), JSON text for a JSON column, else a string, an
// int64, a bool or a float64.
func toDB(f *field, v reflect.Value) (any, error) {
	if !v.IsValid() {
		return nil, nil
	}
	for v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil, nil
		}
		v = v.Elem()
	}
	if f.json {
		return jsonToDB(v)
	}
	switch v.Kind() {
	case reflect.String:
		if f.null && v.Len() == 0 {
			return nil, nil
		}
		return v.String(), nil
	case reflect.Int, reflect.Int64, reflect.Int32:
		if f.null && v.Int() == 0 {
			return nil, nil
		}
		return v.Int(), nil
	case reflect.Bool:
		return v.Bool(), nil
	case reflect.Float64:
		return floatToDB(f, v.Float()), nil
	case reflect.Pointer:
		if v.IsNil() {
			return nil, nil
		}
		return toDB(f, v.Elem())
	}
	return nil, fmt.Errorf("store: column %s: cannot store a %s", f.col, v.Type())
}

// jsonToDB is the text a JSON column stores for v, nil for its zero value.
// Raw JSON, bytes and strings are taken to be JSON already.
func jsonToDB(v reflect.Value) (any, error) {
	if v.IsZero() {
		return nil, nil
	}
	switch raw := v.Interface().(type) {
	case json.RawMessage:
		return string(raw), nil
	case []byte:
		return string(raw), nil
	case string:
		return raw, nil
	}
	b, err := json.Marshal(v.Interface())
	if err != nil {
		return nil, err
	}
	return string(b), nil
}

// floatToDB stores a whole number as an integer: JSON numbers arrive as
// floats when a row is loaded from a backup, into integer columns.
func floatToDB(f *field, n float64) any {
	if n != float64(int64(n)) {
		return n
	}
	if f.null && n == 0 {
		return nil
	}
	return int64(n)
}

// dest is a scan target that fills a struct field from a nullable column.
type dest struct {
	f *field
	v reflect.Value
}

// Scan fills the field from a column's value: NULL is the zero value, a
// JSON column is decoded, other kinds go through database/sql's own
// conversions.
func (d dest) Scan(src any) error {
	if src == nil {
		// NULL is the zero value. Set it, in case the struct held something:
		// a row read again into the same variable must not keep old fields.
		d.v.SetZero()
		return nil
	}
	if d.f.json {
		return d.scanJSON(src)
	}
	switch d.v.Kind() {
	case reflect.String:
		var s sql.NullString
		if err := s.Scan(src); err != nil {
			return err
		}
		d.v.SetString(s.String)
	case reflect.Int, reflect.Int64, reflect.Int32:
		var n sql.NullInt64
		if err := n.Scan(src); err != nil {
			return err
		}
		d.v.SetInt(n.Int64)
	case reflect.Bool:
		var b sql.NullBool
		if err := b.Scan(src); err != nil {
			return err
		}
		d.v.SetBool(b.Bool)
	case reflect.Float64:
		var n sql.NullFloat64
		if err := n.Scan(src); err != nil {
			return err
		}
		d.v.SetFloat(n.Float64)
	default:
		return fmt.Errorf("store: column %s: cannot load into a %s", d.f.col, d.v.Type())
	}
	return nil
}

// scanJSON decodes a JSON column into the field; a json.RawMessage field
// gets a copy of the text as it is.
func (d dest) scanJSON(src any) error {
	var b []byte
	switch text := src.(type) {
	case []byte:
		b = text
	case string:
		b = []byte(text)
	default:
		return fmt.Errorf("store: column %s: unexpected %T", d.f.col, src)
	}
	if d.v.Type() == reflect.TypeFor[json.RawMessage]() {
		d.v.SetBytes(append([]byte(nil), b...))
		return nil
	}
	return json.Unmarshal(b, d.v.Addr().Interface())
}

// dests is the scan targets of a row struct's fields, in column order.
func (m *meta) dests(v reflect.Value) []any {
	out := make([]any, len(m.fields))
	for i := range m.fields {
		out[i] = dest{&m.fields[i], v.Field(m.fields[i].idx)}
	}
	return out
}

// conn is a store.DB: the generic operations, run against a database or a
// transaction. With workspaceID set, it is bound to that workspace.
type conn struct {
	runner
	workspaceID string
}

// where builds the WHERE of a statement on m's table: the workspace first
// (see the file comment), then each condition. No condition is "1 = 1".
func (c conn) where(m *meta, conds []store.Cond) (string, []any, error) {
	where := &clause{}
	if c.workspaceID != "" && !m.table.Global {
		where.add(ident("workspace_id")+" = ?", c.workspaceID)
	}
	for _, cond := range conds {
		if err := where.addCond(m, cond); err != nil {
			return "", nil, err
		}
	}
	return where.sql(), where.args, nil
}

// addCond adds one condition on a column of m's table, or a choice of them.
func (w *clause) addCond(m *meta, cond store.Cond) error {
	if cond.Op == "either" {
		conds, _ := cond.Val.([]store.Cond) // anything else is no choice, which selects nothing
		choices := make([]string, 0, len(conds))
		for _, one := range conds {
			alone := &clause{}
			if err := alone.addCond(m, one); err != nil {
				return err
			}
			choices = append(choices, "("+alone.sql()+")")
			w.args = append(w.args, alone.args...)
		}
		if len(choices) == 0 {
			choices = append(choices, "1 = 0")
		}
		w.parts = append(w.parts, "("+strings.Join(choices, " OR ")+")")
		return nil
	}
	f, ok := m.byCol[cond.Col]
	if !ok {
		return fmt.Errorf("store: table %s has no column %q", m.table.Name, cond.Col)
	}
	col := ident(cond.Col)
	switch cond.Op {
	case "null":
		w.add(col + " IS NULL")
	case "notnull":
		w.add(col + " IS NOT NULL")
	case "in", "notin":
		vals, _ := cond.Val.([]string) // anything but a list of strings is an empty list
		if f.isID {
			vals = onlyIDs(vals)
		}
		if cond.Op == "in" {
			w.in(col, vals)
		} else {
			w.notIn(col, vals)
		}
	case "like":
		w.add("LOWER("+col+") LIKE ?", strings.ToLower(fmt.Sprint(cond.Val)))
	case "=", "!=", ">", ">=", "<", "<=":
		return w.addComparison(f, col, cond)
	default:
		return fmt.Errorf("store: unknown operator %q", cond.Op)
	}
	return nil
}

// addComparison adds "col op ?". A nil value makes "=" IS NULL and any
// other operator IS NOT NULL. Text that cannot be an id, against an id
// column, matches nothing: "=" becomes "1 = 0" and the others are left
// out, as asking Postgres would be an error.
func (w *clause) addComparison(f *field, col string, cond store.Cond) error {
	// The value is compared as given: the column's null and JSON rules are
	// for storing.
	v, err := toDB(&field{col: f.col}, reflect.ValueOf(cond.Val))
	if err != nil {
		return err
	}
	if s, isStr := v.(string); isStr && f.isID && !looksUUID(s) {
		if cond.Op == "=" {
			w.add("1 = 0")
		}
		return nil
	}
	if v == nil {
		if cond.Op == "=" {
			w.add(col + " IS NULL")
		} else {
			w.add(col + " IS NOT NULL")
		}
		return nil
	}
	w.add(col+" "+cond.Op+" ?", v)
	return nil
}

// order turns a Q's Order, "a" or "-a,b", into an ORDER BY of the table's
// own columns, each ascending or (with "-") descending. Anything else in it
// is refused.
func (m *meta) order(spec string) (string, error) {
	if spec == "" {
		return "", nil
	}
	var parts []string
	for name := range strings.SplitSeq(spec, ",") {
		name = strings.TrimSpace(name)
		dir := ""
		if strings.HasPrefix(name, "-") {
			name, dir = name[1:], " DESC"
		}
		col, err := m.column(name)
		if err != nil {
			return "", fmt.Errorf("store: table %s has no column %q to order by", m.table.Name, name)
		}
		parts = append(parts, col+dir)
	}
	return " ORDER BY " + strings.Join(parts, ", "), nil
}

// rowType checks that dst points to a registered row struct, and returns
// the struct and its meta.
func rowType(dst any) (reflect.Value, *meta, error) {
	v := reflect.ValueOf(dst)
	if v.Kind() != reflect.Pointer || v.Elem().Kind() != reflect.Struct {
		return v, nil, fmt.Errorf("store: want a pointer to a row struct, got %T", dst)
	}
	m, err := metaOf(v.Elem().Type())
	return v.Elem(), m, err
}

// Get loads the first row matching where into dst, or returns a
// store.NotFoundError naming the row's table.
func (c conn) Get(ctx context.Context, dst any, where ...store.Cond) error {
	v, m, err := rowType(dst)
	if err != nil {
		return err
	}
	whereSQL, args, err := c.where(m, where)
	if err != nil {
		return err
	}
	err = c.row(ctx, "SELECT "+m.cols+" FROM "+m.name+" WHERE "+whereSQL+" LIMIT 1", args...).Scan(m.dests(v)...)
	if errors.Is(err, sql.ErrNoRows) {
		return m.notFound()
	}
	return err
}

// notFound is the error for a row of m's table that is not there.
func (m *meta) notFound() error { return &store.NotFoundError{What: m.table.Noun} }

// List loads the rows a Q selects into dst, a pointer to a slice of row
// structs.
func (c conn) List(ctx context.Context, dst any, q store.Q) error {
	slice := reflect.ValueOf(dst)
	if slice.Kind() != reflect.Pointer || slice.Elem().Kind() != reflect.Slice {
		return fmt.Errorf("store: want a pointer to a slice, got %T", dst)
	}
	slice = slice.Elem()
	m, err := metaOf(slice.Type().Elem())
	if err != nil {
		return err
	}
	whereSQL, args, err := c.where(m, q.Where)
	if err != nil {
		return err
	}
	order, err := m.order(q.Order)
	if err != nil {
		return err
	}
	query := "SELECT " + m.cols + " FROM " + m.name + " WHERE " + whereSQL + order
	if q.Limit > 0 {
		query += fmt.Sprintf(" LIMIT %d", q.Limit)
		if q.Offset > 0 {
			query += fmt.Sprintf(" OFFSET %d", q.Offset)
		}
	}
	rows, err := c.query(ctx, query, args...)
	if err != nil {
		return err
	}
	return scanAll(rows, m, slice)
}

// scanAll appends every row to slice and closes rows.
func scanAll(rows *sql.Rows, m *meta, slice reflect.Value) error {
	defer rows.Close()                               // rows.Err below reports what went wrong while reading
	slice.Set(reflect.MakeSlice(slice.Type(), 0, 0)) // never nil: an empty list is [] in JSON
	for rows.Next() {
		record := reflect.New(slice.Type().Elem()).Elem()
		if err := rows.Scan(m.dests(record)...); err != nil {
			return err
		}
		slice.Set(reflect.Append(slice, record))
	}
	return rows.Err()
}

// Count counts the rows of a table that match where.
func (c conn) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	whereSQL, args, err := c.where(m, where)
	if err != nil {
		return 0, err
	}
	var n int
	err = c.row(ctx, "SELECT COUNT(*) FROM "+m.name+" WHERE "+whereSQL, args...).Scan(&n)
	return n, err
}

// insertArgs returns the values of row in column order, with c's workspace
// in workspace_id.
func (c conn) insertArgs(m *meta, v reflect.Value) ([]any, error) {
	args := make([]any, len(m.fields))
	for i := range m.fields {
		f := &m.fields[i]
		if f.col == "workspace_id" && c.workspaceID != "" && !m.table.Global {
			args[i] = c.workspaceID
			continue
		}
		arg, err := toDB(f, v.Field(f.idx))
		if err != nil {
			return nil, err
		}
		args[i] = arg
	}
	return args, nil
}

// structOf checks that row is a registered row struct, or a pointer to
// one, and returns the struct and its meta.
func structOf(row any) (reflect.Value, *meta, error) {
	v := reflect.ValueOf(row)
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return v, nil, fmt.Errorf("store: want a row struct, got %T", row)
	}
	m, err := metaOf(v.Type())
	return v, m, err
}

// Insert adds a row; a broken unique rule is store.ErrConflict.
func (c conn) Insert(ctx context.Context, row any) error {
	v, m, err := structOf(row)
	if err != nil {
		return err
	}
	args, err := c.insertArgs(m, v)
	if err != nil {
		return err
	}
	_, err = c.exec(ctx, "INSERT INTO "+m.name+" ("+m.cols+") VALUES ("+placeholders(len(args))+")", args...)
	return conflict(err)
}

// Upsert inserts row, or updates every non-key column if a row with the
// same key columns exists.
func (c conn) Upsert(ctx context.Context, row any, key ...string) error {
	return c.upsert(ctx, row, "", key)
}

// Advance inserts row, or updates the row with the same key columns when
// row's col is greater than the stored one (see store.DB).
func (c conn) Advance(ctx context.Context, row any, col string, key ...string) error {
	if col == "" {
		return errors.New("store: Advance needs the column that only moves forward")
	}
	return c.upsert(ctx, row, col, key)
}

// upsert is Upsert and Advance: one INSERT … ON CONFLICT, whose update,
// when forward names a column, applies only if it moves that column
// forward. Both databases spell the conditional update alike.
func (c conn) upsert(ctx context.Context, row any, forward string, key []string) error {
	v, m, err := structOf(row)
	if err != nil {
		return err
	}
	args, err := c.insertArgs(m, v)
	if err != nil {
		return err
	}
	isKey := map[string]bool{}
	var keys []string
	for _, name := range key {
		col, err := m.column(name)
		if err != nil {
			return err
		}
		isKey[name] = true
		keys = append(keys, col)
	}
	var sets []string
	for _, f := range m.fields {
		if !isKey[f.col] {
			sets = append(sets, ident(f.col)+" = excluded."+ident(f.col))
		}
	}
	action := "DO NOTHING"
	if len(sets) > 0 {
		action = "DO UPDATE SET " + strings.Join(sets, ", ")
		if forward != "" {
			col, err := m.column(forward)
			if err != nil {
				return err
			}
			action += " WHERE " + m.name + "." + col + " < excluded." + col
		}
	}
	_, err = c.exec(ctx, "INSERT INTO "+m.name+" ("+m.cols+") VALUES ("+placeholders(len(args))+
		") ON CONFLICT ("+strings.Join(keys, ", ")+") "+action, args...)
	return conflict(err)
}

// Update sets columns on the matching rows and returns how many changed.
// The columns are set in name order, so one change is one statement.
func (c conn) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	if len(set) == 0 {
		return 0, nil
	}
	var sets []string
	var args []any
	for _, col := range slices.Sorted(maps.Keys(set)) {
		f, ok := m.byCol[col]
		if !ok {
			return 0, fmt.Errorf("store: table %s has no column %q", table, col)
		}
		arg, err := toDB(f, reflect.ValueOf(set[col]))
		if err != nil {
			return 0, err
		}
		sets = append(sets, ident(col)+" = ?")
		args = append(args, arg)
	}
	whereSQL, whereArgs, err := c.where(m, where)
	if err != nil {
		return 0, err
	}
	res, err := c.exec(ctx, "UPDATE "+m.name+" SET "+strings.Join(sets, ", ")+" WHERE "+whereSQL, append(args, whereArgs...)...)
	if err != nil {
		return 0, conflict(err)
	}
	return res.RowsAffected()
}

// Delete removes the matching rows and returns how many there were.
func (c conn) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	whereSQL, args, err := c.where(m, where)
	if err != nil {
		return 0, err
	}
	res, err := c.exec(ctx, "DELETE FROM "+m.name+" WHERE "+whereSQL, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Incr adds n to a counter column on one row and returns the new value. A
// row that is not there is made from the conditions, with the counter at n
// (see store.DB): the update is tried first, as the row is usually there,
// and the insert settles a race with another caller making the same row
// through ON CONFLICT, which both databases spell alike.
func (c conn) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	counter, err := m.column(col)
	if err != nil {
		return 0, err
	}
	whereSQL, args, err := c.where(m, where)
	if err != nil {
		return 0, err
	}
	var out int64
	err = c.row(ctx, "UPDATE "+m.name+" SET "+counter+" = "+counter+" + ? WHERE "+whereSQL+" RETURNING "+counter, append([]any{n}, args...)...).Scan(&out)
	if !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}

	// No row: make one. Its key is the conditions' columns, each of which
	// must say column = value.
	cols, keys := []string{counter}, []string{}
	vals := []any{n}
	for _, cond := range where {
		f, ok := m.byCol[cond.Col]
		if !ok || cond.Op != "=" {
			return 0, m.notFound()
		}
		v, err := toDB(f, reflect.ValueOf(cond.Val))
		if err != nil {
			return 0, err
		}
		if s, isStr := v.(string); v == nil || isStr && f.isID && !looksUUID(s) {
			return 0, m.notFound() // no row can have it
		}
		cols, keys, vals = append(cols, ident(f.col)), append(keys, ident(f.col)), append(vals, v)
	}
	// A row of another workspace with the same key is left alone: the
	// update applies only to a row of this one.
	guard := ""
	if c.workspaceID != "" && !m.table.Global {
		cols, vals = append(cols, ident("workspace_id")), append(vals, c.workspaceID)
		guard = " WHERE " + m.name + "." + ident("workspace_id") + " = ?"
		vals = append(vals, c.workspaceID)
	}
	if len(keys) == 0 {
		return 0, m.notFound()
	}
	err = c.row(ctx, "INSERT INTO "+m.name+" ("+strings.Join(cols, ", ")+") VALUES ("+placeholders(len(cols))+
		") ON CONFLICT ("+strings.Join(keys, ", ")+") DO UPDATE SET "+counter+" = "+m.name+"."+counter+" + excluded."+counter+guard+
		" RETURNING "+counter, vals...).Scan(&out)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, m.notFound()
	}
	return out, conflict(err)
}

// Tally counts the matching rows of a table grouped by the given columns,
// each group's values as text ("" for NULL).
func (c conn) Tally(ctx context.Context, table string, groupBy []string, where ...store.Cond) ([]store.TallyRow, error) {
	m, err := metaNamed(table)
	if err != nil {
		return nil, err
	}
	var selected, groups []string
	for _, name := range groupBy {
		col, err := m.column(name)
		if err != nil {
			return nil, err
		}
		selected = append(selected, "COALESCE(CAST("+col+" AS TEXT), '')")
		groups = append(groups, col)
	}
	whereSQL, args, err := c.where(m, where)
	if err != nil {
		return nil, err
	}
	query := "SELECT " + strings.Join(append(selected, "COUNT(*)"), ", ") + " FROM " + m.name + " WHERE " + whereSQL
	if len(groupBy) > 0 {
		query += " GROUP BY " + strings.Join(groups, ", ")
	}
	rows, err := c.query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close() // rows.Err below reports what went wrong while reading
	var out []store.TallyRow
	for rows.Next() {
		group := store.TallyRow{Keys: make([]string, len(groupBy))}
		targets := make([]any, 0, len(groupBy)+1)
		for i := range group.Keys {
			targets = append(targets, &group.Keys[i])
		}
		if err := rows.Scan(append(targets, &group.Count)...); err != nil {
			return nil, err
		}
		out = append(out, group)
	}
	return out, rows.Err()
}

// conflict maps a broken unique rule to store.ErrConflict on either
// database, keeping the database's error inside it.
func conflict(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") || strings.Contains(msg, "SQLSTATE 23505") {
		return fmt.Errorf("%w: %w", store.ErrConflict, err)
	}
	return err
}
