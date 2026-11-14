package sqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"

	"github.com/agrigoryan/quadit/internal/store"
)

// field is one column of a row struct.
type field struct {
	idx  int
	col  string
	null bool // the zero value is stored as NULL
	json bool // stored as JSON
	isID bool // holds a UUID
}

// meta is what the mapper knows about one row type.
type meta struct {
	table  *store.Table
	fields []field
	byCol  map[string]*field
	cols   string // "a, b, c"
}

var metas sync.Map // reflect.Type -> *meta

func metaOf(t reflect.Type) (*meta, error) {
	if m, ok := metas.Load(t); ok {
		return m.(*meta), nil
	}
	tb, ok := store.TableOf(t)
	if !ok {
		return nil, fmt.Errorf("store: %s is not a registered row type", t)
	}
	m := &meta{table: tb, byCol: map[string]*field{}}
	var cols []string
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("db")
		if tag == "" || tag == "-" {
			continue
		}
		parts := strings.Split(tag, ",")
		f := field{idx: i, col: parts[0]}
		for _, opt := range parts[1:] {
			switch opt {
			case "null":
				f.null = true
			case "json":
				f.json = true
			}
		}
		f.isID = (f.col == "id" || strings.HasSuffix(f.col, "_id")) && !textIDs[tb.Name+"."+f.col]
		m.fields = append(m.fields, f)
		cols = append(cols, f.col)
	}
	for i := range m.fields {
		m.byCol[m.fields[i].col] = &m.fields[i]
	}
	m.cols = strings.Join(cols, ", ")
	metas.Store(t, m)
	return m, nil
}

// textIDs are the *_id columns that do not hold UUIDs.
var textIDs = map[string]bool{"oauth_clients.id": true, "audit_log.target_id": true, "api_tokens.client_id": true}

func metaNamed(table string) (*meta, error) {
	tb, ok := store.TableNamed(table)
	if !ok {
		return nil, fmt.Errorf("store: unknown table %q", table)
	}
	return metaOf(tb.Type)
}

func looksUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// toDB turns a Go value into what is stored in f's column.
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
		if v.IsZero() {
			return nil, nil
		}
		switch x := v.Interface().(type) {
		case json.RawMessage:
			return string(x), nil
		case []byte:
			return string(x), nil
		case string:
			return x, nil
		}
		b, err := json.Marshal(v.Interface())
		if err != nil {
			return nil, err
		}
		return string(b), nil
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
		// JSON numbers arrive as floats when a row is loaded from a backup.
		if v.Float() == float64(int64(v.Float())) {
			if f.null && v.Float() == 0 {
				return nil, nil
			}
			return int64(v.Float()), nil
		}
		return v.Float(), nil
	case reflect.Pointer:
		if v.IsNil() {
			return nil, nil
		}
		return toDB(f, v.Elem())
	}
	return nil, fmt.Errorf("store: column %s: cannot store a %s", f.col, v.Type())
}

// dest is a scan target that fills a struct field from a nullable column.
type dest struct {
	f *field
	v reflect.Value
}

func (d dest) Scan(src any) error {
	if src == nil {
		// NULL is the zero value. Set it, in case the struct held something:
		// a row read again into the same variable must not keep old fields.
		d.v.SetZero()
		return nil
	}
	if d.f.json {
		var b []byte
		switch x := src.(type) {
		case []byte:
			b = x
		case string:
			b = []byte(x)
		default:
			return fmt.Errorf("store: column %s: unexpected %T", d.f.col, src)
		}
		if d.v.Type() == reflect.TypeFor[json.RawMessage]() {
			d.v.SetBytes(append([]byte(nil), b...))
			return nil
		}
		return json.Unmarshal(b, d.v.Addr().Interface())
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

func (m *meta) dests(v reflect.Value) []any {
	out := make([]any, len(m.fields))
	for i := range m.fields {
		out[i] = dest{&m.fields[i], v.Field(m.fields[i].idx)}
	}
	return out
}

// conn runs the generic operations against a database or a transaction.
// When ws is set, queries on workspace tables are limited to it.
type conn struct {
	q
	ws string
}

// where builds the WHERE clause. prefix is a table alias with its dot, or "".
func (c conn) where(m *meta, prefix string, conds []store.Cond) (string, []any, error) {
	var parts []string
	var args []any
	if c.ws != "" && !m.table.Global {
		parts = append(parts, prefix+"workspace_id = ?")
		args = append(args, c.ws)
	}
	for _, cd := range conds {
		f, ok := m.byCol[cd.Col]
		if !ok {
			return "", nil, fmt.Errorf("store: table %s has no column %q", m.table.Name, cd.Col)
		}
		col := prefix + cd.Col
		switch cd.Op {
		case "null":
			parts = append(parts, col+" IS NULL")
		case "notnull":
			parts = append(parts, col+" IS NOT NULL")
		case "in", "notin":
			vals, _ := cd.Val.([]string)
			var keep []string
			for _, v := range vals {
				if !f.isID || looksUUID(v) {
					keep = append(keep, v)
				}
			}
			if len(keep) == 0 {
				if cd.Op == "in" {
					parts = append(parts, "1 = 0")
				}
				continue
			}
			in, a := marks(keep)
			op := " IN ("
			if cd.Op == "notin" {
				op = " NOT IN ("
			}
			parts = append(parts, col+op+in+")")
			args = append(args, a...)
		case "like":
			parts = append(parts, "LOWER("+col+") LIKE ?")
			args = append(args, strings.ToLower(fmt.Sprint(cd.Val)))
		case "=", "!=", ">", ">=", "<", "<=":
			v, err := toDB(&field{col: f.col, json: false}, reflect.ValueOf(cd.Val))
			if err != nil {
				return "", nil, err
			}
			if s, isStr := v.(string); isStr && f.isID && !looksUUID(s) {
				// Not an id, so nothing can match; asking the database
				// would be an error on Postgres.
				if cd.Op == "=" {
					parts = append(parts, "1 = 0")
				}
				continue
			}
			if v == nil {
				if cd.Op == "=" {
					parts = append(parts, col+" IS NULL")
				} else {
					parts = append(parts, col+" IS NOT NULL")
				}
				continue
			}
			parts = append(parts, col+" "+cd.Op+" ?")
			args = append(args, v)
		default:
			return "", nil, fmt.Errorf("store: unknown operator %q", cd.Op)
		}
	}
	if len(parts) == 0 {
		return "1 = 1", nil, nil
	}
	return strings.Join(parts, " AND "), args, nil
}

func (m *meta) order(spec string) (string, error) {
	if spec == "" {
		return "", nil
	}
	var parts []string
	for _, c := range strings.Split(spec, ",") {
		c = strings.TrimSpace(c)
		dir := ""
		if strings.HasPrefix(c, "-") {
			c, dir = c[1:], " DESC"
		}
		if _, ok := m.byCol[c]; !ok {
			return "", fmt.Errorf("store: table %s has no column %q to order by", m.table.Name, c)
		}
		parts = append(parts, c+dir)
	}
	return " ORDER BY " + strings.Join(parts, ", "), nil
}

func rowType(dst any) (reflect.Value, *meta, error) {
	v := reflect.ValueOf(dst)
	if v.Kind() != reflect.Pointer || v.Elem().Kind() != reflect.Struct {
		return v, nil, fmt.Errorf("store: want a pointer to a row struct, got %T", dst)
	}
	m, err := metaOf(v.Elem().Type())
	return v.Elem(), m, err
}

func (c conn) Get(ctx context.Context, dst any, where ...store.Cond) error {
	v, m, err := rowType(dst)
	if err != nil {
		return err
	}
	w, args, err := c.where(m, "", where)
	if err != nil {
		return err
	}
	err = c.row(ctx, "SELECT "+m.cols+" FROM "+m.table.Name+" WHERE "+w+" LIMIT 1", args...).Scan(m.dests(v)...)
	if errors.Is(err, sql.ErrNoRows) {
		return store.ErrNotFound
	}
	return err
}

func (c conn) List(ctx context.Context, dst any, q store.Q) error {
	sv := reflect.ValueOf(dst)
	if sv.Kind() != reflect.Pointer || sv.Elem().Kind() != reflect.Slice {
		return fmt.Errorf("store: want a pointer to a slice, got %T", dst)
	}
	sv = sv.Elem()
	m, err := metaOf(sv.Type().Elem())
	if err != nil {
		return err
	}
	w, args, err := c.where(m, "", q.Where)
	if err != nil {
		return err
	}
	order, err := m.order(q.Order)
	if err != nil {
		return err
	}
	query := "SELECT " + m.cols + " FROM " + m.table.Name + " WHERE " + w + order
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
	return scanAll(rows, m, sv)
}

// scanAll appends every row to the slice sv and closes rows.
func scanAll(rows *sql.Rows, m *meta, sv reflect.Value) error {
	defer rows.Close()
	sv.Set(reflect.MakeSlice(sv.Type(), 0, 0)) // never nil: an empty list is [] in JSON
	for rows.Next() {
		el := reflect.New(sv.Type().Elem()).Elem()
		if err := rows.Scan(m.dests(el)...); err != nil {
			return err
		}
		sv.Set(reflect.Append(sv, el))
	}
	return rows.Err()
}

func (c conn) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	w, args, err := c.where(m, "", where)
	if err != nil {
		return 0, err
	}
	var n int
	err = c.row(ctx, "SELECT COUNT(*) FROM "+table+" WHERE "+w, args...).Scan(&n)
	return n, err
}

// insertArgs returns the values of row in column order.
func (c conn) insertArgs(m *meta, v reflect.Value) ([]any, error) {
	args := make([]any, len(m.fields))
	for i := range m.fields {
		f := &m.fields[i]
		if f.col == "workspace_id" && c.ws != "" && !m.table.Global {
			args[i] = c.ws
			continue
		}
		a, err := toDB(f, v.Field(f.idx))
		if err != nil {
			return nil, err
		}
		args[i] = a
	}
	return args, nil
}

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

func (c conn) Insert(ctx context.Context, row any) error {
	v, m, err := structOf(row)
	if err != nil {
		return err
	}
	args, err := c.insertArgs(m, v)
	if err != nil {
		return err
	}
	_, err = c.exec(ctx, "INSERT INTO "+m.table.Name+" ("+m.cols+") VALUES ("+placeholders(len(args))+")", args...)
	return conflict(err)
}

func (c conn) Upsert(ctx context.Context, row any, key ...string) error {
	v, m, err := structOf(row)
	if err != nil {
		return err
	}
	args, err := c.insertArgs(m, v)
	if err != nil {
		return err
	}
	isKey := map[string]bool{}
	for _, k := range key {
		isKey[k] = true
	}
	var sets []string
	for _, f := range m.fields {
		if !isKey[f.col] {
			sets = append(sets, f.col+" = excluded."+f.col)
		}
	}
	action := "DO NOTHING"
	if len(sets) > 0 {
		action = "DO UPDATE SET " + strings.Join(sets, ", ")
	}
	_, err = c.exec(ctx, "INSERT INTO "+m.table.Name+" ("+m.cols+") VALUES ("+placeholders(len(args))+
		") ON CONFLICT ("+strings.Join(key, ", ")+") "+action, args...)
	return conflict(err)
}

func (c conn) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	if len(set) == 0 {
		return 0, nil
	}
	cols := make([]string, 0, len(set))
	for k := range set {
		cols = append(cols, k)
	}
	sort.Strings(cols)
	var sets []string
	var args []any
	for _, col := range cols {
		f, ok := m.byCol[col]
		if !ok {
			return 0, fmt.Errorf("store: table %s has no column %q", table, col)
		}
		a, err := toDB(f, reflect.ValueOf(set[col]))
		if err != nil {
			return 0, err
		}
		sets = append(sets, col+" = ?")
		args = append(args, a)
	}
	w, wargs, err := c.where(m, "", where)
	if err != nil {
		return 0, err
	}
	res, err := c.exec(ctx, "UPDATE "+table+" SET "+strings.Join(sets, ", ")+" WHERE "+w, append(args, wargs...)...)
	if err != nil {
		return 0, conflict(err)
	}
	return res.RowsAffected()
}

func (c conn) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	w, args, err := c.where(m, "", where)
	if err != nil {
		return 0, err
	}
	res, err := c.exec(ctx, "DELETE FROM "+table+" WHERE "+w, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (c conn) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	m, err := metaNamed(table)
	if err != nil {
		return 0, err
	}
	if _, ok := m.byCol[col]; !ok {
		return 0, fmt.Errorf("store: table %s has no column %q", table, col)
	}
	w, args, err := c.where(m, "", where)
	if err != nil {
		return 0, err
	}
	var out int64
	err = c.row(ctx, "UPDATE "+table+" SET "+col+" = "+col+" + ? WHERE "+w+" RETURNING "+col, append([]any{n}, args...)...).Scan(&out)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, store.ErrNotFound
	}
	return out, err
}

func (c conn) Tally(ctx context.Context, table string, groupBy []string, where ...store.Cond) ([]store.TallyRow, error) {
	m, err := metaNamed(table)
	if err != nil {
		return nil, err
	}
	var sel []string
	for _, g := range groupBy {
		if _, ok := m.byCol[g]; !ok {
			return nil, fmt.Errorf("store: table %s has no column %q", table, g)
		}
		sel = append(sel, "COALESCE(CAST("+g+" AS TEXT), '')")
	}
	w, args, err := c.where(m, "", where)
	if err != nil {
		return nil, err
	}
	query := "SELECT " + strings.Join(append(sel, "COUNT(*)"), ", ") + " FROM " + table + " WHERE " + w
	if len(groupBy) > 0 {
		query += " GROUP BY " + strings.Join(groupBy, ", ")
	}
	rows, err := c.query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.TallyRow
	for rows.Next() {
		r := store.TallyRow{Keys: make([]string, len(groupBy))}
		dst := make([]any, 0, len(groupBy)+1)
		for i := range r.Keys {
			dst = append(dst, &r.Keys[i])
		}
		if err := rows.Scan(append(dst, &r.Count)...); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

// marks returns "?, ?, ?" for n values, and the values as arguments.
func marks(vals []string) (string, []any) {
	args := make([]any, len(vals))
	for i, v := range vals {
		args[i] = v
	}
	return placeholders(len(vals)), args
}

// conflict maps a broken unique rule to store.ErrConflict on either database.
func conflict(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") || strings.Contains(msg, "SQLSTATE 23505") {
		return fmt.Errorf("%w: %v", store.ErrConflict, err)
	}
	return err
}
