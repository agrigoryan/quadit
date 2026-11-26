// A transaction that remembers the small rows a write reads again and again.

package engine

import (
	"context"
	"fmt"
	"reflect"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// memoTx remembers, for the length of one write, the single rows read from a
// few small tables that every change looks up again and again: who a handle
// is, what a status or a label is called. A batch of a thousand new tasks
// asks for the same assignee a thousand times; with this it asks once.
//
// Nothing else can write to the workspace while the write holds it, so a
// remembered row is stale only if this write changed its table, and any
// write to one of these tables forgets everything.
type memoTx struct {
	store.Tx
	rows map[string]reflect.Value
}

var memoTypes = map[reflect.Type]bool{
	reflect.TypeFor[core.Member](): true,
	reflect.TypeFor[core.Status](): true,
	reflect.TypeFor[core.Label]():  true,
}

var memoTables = map[string]bool{"members": true, "statuses": true, "labels": true}

func newMemoTx(tx store.Tx) *memoTx { return &memoTx{Tx: tx, rows: map[string]reflect.Value{}} }

// Get loads a row, from memory when it is of a remembered table and was read
// before.
func (m *memoTx) Get(ctx context.Context, dst any, where ...store.Cond) error {
	v := reflect.ValueOf(dst)
	if v.Kind() != reflect.Pointer || !memoTypes[v.Elem().Type()] {
		return m.Tx.Get(ctx, dst, where...)
	}
	key := v.Elem().Type().Name() + fmt.Sprint(where)
	if row, ok := m.rows[key]; ok {
		v.Elem().Set(cloneRow(row))
		return nil
	}
	if err := m.Tx.Get(ctx, dst, where...); err != nil {
		return err
	}
	m.rows[key] = cloneRow(v.Elem())
	return nil
}

// List remembers whole lists of the same small tables the same way.
func (m *memoTx) List(ctx context.Context, dst any, q store.Q) error {
	v := reflect.ValueOf(dst)
	if v.Kind() != reflect.Pointer || v.Elem().Kind() != reflect.Slice || !memoTypes[v.Elem().Type().Elem()] {
		return m.Tx.List(ctx, dst, q)
	}
	key := "[]" + v.Elem().Type().Elem().Name() + fmt.Sprint(q)
	if rows, ok := m.rows[key]; ok {
		v.Elem().Set(cloneRows(rows))
		return nil
	}
	if err := m.Tx.List(ctx, dst, q); err != nil {
		return err
	}
	m.rows[key] = cloneRows(v.Elem())
	return nil
}

func cloneRows(src reflect.Value) reflect.Value {
	out := reflect.MakeSlice(src.Type(), src.Len(), src.Len())
	for i := 0; i < src.Len(); i++ {
		out.Index(i).Set(cloneRow(src.Index(i)))
	}
	if src.IsNil() {
		return reflect.Zero(src.Type())
	}
	return out
}

// cloneRow copies a row so that the copy shares nothing that can be changed
// through it: its pointers, slices and maps are copied one level down.
func cloneRow(src reflect.Value) reflect.Value {
	out := reflect.New(src.Type()).Elem()
	out.Set(src)
	for _, f := range out.Fields() {
		if !f.CanSet() {
			continue
		}
		switch f.Kind() {
		case reflect.Pointer:
			if !f.IsNil() {
				p := reflect.New(f.Type().Elem())
				if f.Elem().Kind() == reflect.Struct {
					p.Elem().Set(cloneRow(f.Elem()))
				} else {
					p.Elem().Set(f.Elem())
				}
				f.Set(p)
			}
		case reflect.Slice:
			if !f.IsNil() {
				s := reflect.MakeSlice(f.Type(), f.Len(), f.Len())
				reflect.Copy(s, f)
				f.Set(s)
			}
		case reflect.Map:
			if !f.IsNil() {
				mp := reflect.MakeMapWithSize(f.Type(), f.Len())
				for it := f.MapRange(); it.Next(); {
					mp.SetMapIndex(it.Key(), it.Value())
				}
				f.Set(mp)
			}
		}
	}
	return out
}

func (m *memoTx) forgetRow(row any) {
	t := reflect.TypeOf(row)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if memoTypes[t] {
		clear(m.rows)
	}
}

func (m *memoTx) forgetTable(table string) {
	if memoTables[table] {
		clear(m.rows)
	}
}

// Insert writes a row and forgets what was remembered of its table.
func (m *memoTx) Insert(ctx context.Context, row any) error {
	m.forgetRow(row)
	return m.Tx.Insert(ctx, row)
}

// Upsert writes a row and forgets what was remembered of its table.
func (m *memoTx) Upsert(ctx context.Context, row any, key ...string) error {
	m.forgetRow(row)
	return m.Tx.Upsert(ctx, row, key...)
}

// Ensure writes a row and forgets what was remembered of its table.
func (m *memoTx) Ensure(ctx context.Context, row any, key ...string) error {
	m.forgetRow(row)
	return m.Tx.Ensure(ctx, row, key...)
}

// Advance writes a row and forgets what was remembered of its table.
func (m *memoTx) Advance(ctx context.Context, row any, col string, key ...string) error {
	m.forgetRow(row)
	return m.Tx.Advance(ctx, row, col, key...)
}

// Update writes rows and forgets what was remembered of the table.
func (m *memoTx) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	m.forgetTable(table)
	return m.Tx.Update(ctx, table, set, where...)
}

// Delete removes rows and forgets what was remembered of the table.
func (m *memoTx) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	m.forgetTable(table)
	return m.Tx.Delete(ctx, table, where...)
}

// Incr counts on a row and forgets what was remembered of the table.
func (m *memoTx) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	m.forgetTable(table)
	return m.Tx.Incr(ctx, table, col, n, where...)
}
