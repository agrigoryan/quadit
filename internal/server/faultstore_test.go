package server_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// errOutage is what a faulty store answers in place of a row.
var errOutage = errors.New("the database is not answering (a test fault)")

// fault fails the calls of one operation on one table: op is "get",
// "list", "count", "insert", "upsert", "update", "delete" or "incr", table is
// the table's name.
type fault struct {
	op, table string
	// match narrows the calls that fail; nil fails them all.
	match func(set map[string]any, where []store.Cond) bool
	// times is how many calls fail before the fault is spent; 0 fails every
	// call until the faults are cleared.
	times int
	// err is what a failed call answers; nil answers errOutage.
	err error

	hits int
}

// faults are the faults a faulty store checks every call against.
type faults struct {
	mu   sync.Mutex
	list []*fault
}

// set makes these operations, each named as operation plus table ("get
// settings", "update sessions"), fail until clear.
func (f *faults) set(ops ...string) {
	for _, op := range ops {
		name, table, _ := strings.Cut(op, " ")
		f.arm(fault{op: name, table: table})
	}
}

// arm adds a fault and returns a function that says how often it fired.
func (f *faults) arm(ft fault) func() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.list = append(f.list, &ft)
	return func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		return ft.hits
	}
}

// clear makes every operation work again.
func (f *faults) clear() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.list = nil
}

// check is the error a call gives: errOutage when a fault that is not spent
// matches it.
func (f *faults) check(op, table string, set map[string]any, where []store.Cond) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ft := range f.list {
		if ft.op != op || ft.table != table || (ft.times > 0 && ft.hits >= ft.times) {
			continue
		}
		if ft.match == nil || ft.match(set, where) {
			ft.hits++
			if ft.err != nil {
				return ft.err
			}
			return errOutage
		}
	}
	return nil
}

// idIs matches the calls about the row with this id.
func idIs(rowID string) func(map[string]any, []store.Cond) bool {
	return func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "id", rowID) }
}

// whereHas reports whether the conditions say col = val.
func whereHas(where []store.Cond, col string, val any) bool {
	for _, c := range where {
		if c.Col == col && c.Op == "=" && c.Val == val {
			return true
		}
	}
	return false
}

// tableOf names the table of a row, a pointer to one, or a list of them.
func tableOf(row any) string {
	t := reflect.TypeOf(row)
	for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice {
		t = t.Elem()
	}
	if tb, ok := store.TableOf(t); ok {
		return tb.Name
	}
	return t.Name()
}

// faultyDB is a store.DB whose operations fail when its faults say so.
type faultyDB struct {
	store.DB
	faults *faults
}

func (d *faultyDB) Get(ctx context.Context, dst any, where ...store.Cond) error {
	if err := d.faults.check("get", tableOf(dst), nil, where); err != nil {
		return err
	}
	return d.DB.Get(ctx, dst, where...)
}

func (d *faultyDB) List(ctx context.Context, dst any, q store.Q) error {
	if err := d.faults.check("list", tableOf(dst), nil, q.Where); err != nil {
		return err
	}
	return d.DB.List(ctx, dst, q)
}

func (d *faultyDB) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if err := d.faults.check("count", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Count(ctx, table, where...)
}

func (d *faultyDB) Insert(ctx context.Context, row any) error {
	if err := d.faults.check("insert", tableOf(row), nil, nil); err != nil {
		return err
	}
	return d.DB.Insert(ctx, row)
}

func (d *faultyDB) Upsert(ctx context.Context, row any, key ...string) error {
	if err := d.faults.check("upsert", tableOf(row), nil, nil); err != nil {
		return err
	}
	return d.DB.Upsert(ctx, row, key...)
}

func (d *faultyDB) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	if err := d.faults.check("update", table, set, where); err != nil {
		return 0, err
	}
	return d.DB.Update(ctx, table, set, where...)
}

func (d *faultyDB) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	if err := d.faults.check("delete", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Delete(ctx, table, where...)
}

func (d *faultyDB) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	if err := d.faults.check("incr", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Incr(ctx, table, col, n, where...)
}

func (d *faultyDB) Tasks(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	if err := d.faults.check("list", "tasks", nil, nil); err != nil {
		return nil, err
	}
	return d.DB.Tasks(ctx, f)
}

func (d *faultyDB) CountTasks(ctx context.Context, f store.TaskFilter) (int, error) {
	if err := d.faults.check("count", "tasks", nil, nil); err != nil {
		return 0, err
	}
	return d.DB.CountTasks(ctx, f)
}

func (d *faultyDB) Events(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	if err := d.faults.check("list", "events", nil, nil); err != nil {
		return nil, err
	}
	return d.DB.Events(ctx, f)
}

// faultyStore is a store.Store whose operations, in every workspace, fail
// when its faults say so.
type faultyStore struct {
	store.Store
	faults *faults
}

func newFaultyStore(st store.Store) *faultyStore {
	return &faultyStore{Store: st, faults: &faults{}}
}

func (s *faultyStore) db() *faultyDB { return &faultyDB{DB: s.Store, faults: s.faults} }

func (s *faultyStore) Get(ctx context.Context, dst any, where ...store.Cond) error {
	return s.db().Get(ctx, dst, where...)
}

func (s *faultyStore) List(ctx context.Context, dst any, q store.Q) error {
	return s.db().List(ctx, dst, q)
}

func (s *faultyStore) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	return s.db().Count(ctx, table, where...)
}

func (s *faultyStore) Insert(ctx context.Context, row any) error {
	return s.db().Insert(ctx, row)
}

func (s *faultyStore) Upsert(ctx context.Context, row any, key ...string) error {
	return s.db().Upsert(ctx, row, key...)
}

func (s *faultyStore) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	return s.db().Update(ctx, table, set, where...)
}

func (s *faultyStore) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	return s.db().Delete(ctx, table, where...)
}

func (s *faultyStore) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	return s.db().Incr(ctx, table, col, n, where...)
}

func (s *faultyStore) Tasks(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	return s.db().Tasks(ctx, f)
}

func (s *faultyStore) CountTasks(ctx context.Context, f store.TaskFilter) (int, error) {
	return s.db().CountTasks(ctx, f)
}

func (s *faultyStore) Events(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	return s.db().Events(ctx, f)
}

func (s *faultyStore) In(workspaceID string) store.DB {
	return &faultyDB{DB: s.Store.In(workspaceID), faults: s.faults}
}

func (s *faultyStore) Atomic(ctx context.Context, fn func(store.DB) error) error {
	return s.Store.Atomic(ctx, func(db store.DB) error { return fn(&faultyDB{DB: db, faults: s.faults}) })
}

func (s *faultyStore) Write(ctx context.Context, workspaceID string, fn func(store.Tx) error) error {
	return s.Store.Write(ctx, workspaceID, func(tx store.Tx) error {
		return fn(faultyTx{faultyDB: &faultyDB{DB: tx, faults: s.faults}, tx: tx})
	})
}

// faultyTx is a faulty store's write: its reads and writes fail as the
// store's do; the event numbers and the events themselves never fail.
type faultyTx struct {
	*faultyDB
	tx store.Tx
}

func (t faultyTx) WorkspaceID() string { return t.tx.WorkspaceID() }
func (t faultyTx) Seq() int64          { return t.tx.Seq() }
func (t faultyTx) NextSeq() int64      { return t.tx.NextSeq() }
func (t faultyTx) Emit(ctx context.Context, ev core.Event) error {
	return t.tx.Emit(ctx, ev)
}
func (t faultyTx) Load(ctx context.Context, table string, rows []map[string]any) error {
	return t.tx.Load(ctx, table, rows)
}
func (t faultyTx) Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...store.Cond) error {
	return t.tx.Overwrite(ctx, table, row, keep, where...)
}

// failGet makes every Get of that kind of row fail until the test ends.
func failGet(t *testing.T, fs *faultyStore, row any) {
	t.Helper()
	fs.faults.set("get " + tableOf(row))
	t.Cleanup(fs.faults.clear)
}
