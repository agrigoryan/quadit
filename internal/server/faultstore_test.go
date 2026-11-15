package server_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// errOutage is what a faulty store answers in place of a row.
var errOutage = errors.New("the database is not answering (a test fault)")

// faults are the operations a faulty store fails, each named as operation
// plus table: "get settings", "update sessions", "count passkeys".
type faults struct {
	mu   sync.Mutex
	fail map[string]bool
}

// set makes these operations fail until clear.
func (f *faults) set(ops ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail == nil {
		f.fail = map[string]bool{}
	}
	for _, op := range ops {
		f.fail[op] = true
	}
}

// clear makes every operation work again.
func (f *faults) clear() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = nil
}

// check is the error an operation on a table gives: errOutage when it was
// set to fail.
func (f *faults) check(op, table string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail[op+" "+table] {
		return errOutage
	}
	return nil
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
	if err := d.faults.check("get", tableOf(dst)); err != nil {
		return err
	}
	return d.DB.Get(ctx, dst, where...)
}

func (d *faultyDB) List(ctx context.Context, dst any, q store.Q) error {
	if err := d.faults.check("list", tableOf(dst)); err != nil {
		return err
	}
	return d.DB.List(ctx, dst, q)
}

func (d *faultyDB) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if err := d.faults.check("count", table); err != nil {
		return 0, err
	}
	return d.DB.Count(ctx, table, where...)
}

func (d *faultyDB) Upsert(ctx context.Context, row any, key ...string) error {
	if err := d.faults.check("upsert", tableOf(row)); err != nil {
		return err
	}
	return d.DB.Upsert(ctx, row, key...)
}

func (d *faultyDB) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	if err := d.faults.check("update", table); err != nil {
		return 0, err
	}
	return d.DB.Update(ctx, table, set, where...)
}

func (d *faultyDB) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	if err := d.faults.check("incr", table); err != nil {
		return 0, err
	}
	return d.DB.Incr(ctx, table, col, n, where...)
}

func (d *faultyDB) Tasks(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	if err := d.faults.check("list", "tasks"); err != nil {
		return nil, err
	}
	return d.DB.Tasks(ctx, f)
}

func (d *faultyDB) CountTasks(ctx context.Context, f store.TaskFilter) (int, error) {
	if err := d.faults.check("count", "tasks"); err != nil {
		return 0, err
	}
	return d.DB.CountTasks(ctx, f)
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

func (s *faultyStore) Upsert(ctx context.Context, row any, key ...string) error {
	return s.db().Upsert(ctx, row, key...)
}

func (s *faultyStore) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	return s.db().Update(ctx, table, set, where...)
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

func (s *faultyStore) In(workspaceID string) store.DB {
	return &faultyDB{DB: s.Store.In(workspaceID), faults: s.faults}
}

func (s *faultyStore) Atomic(ctx context.Context, fn func(store.DB) error) error {
	return s.Store.Atomic(ctx, func(db store.DB) error { return fn(&faultyDB{DB: db, faults: s.faults}) })
}

// failGet makes every Get of that kind of row fail until the test ends.
func failGet(t *testing.T, fs *faultyStore, row any) {
	t.Helper()
	fs.faults.set("get " + tableOf(row))
	t.Cleanup(fs.faults.clear)
}
