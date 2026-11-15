package server_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
)

// A store that fails on demand, for tests of what the server does when the
// database has trouble: newFaultyStore wraps the test's store, and
// faults.set names the operations that fail ("get settings",
// "update sessions").

// errOutage is what a faultyStore answers with for an operation set to fail.
var errOutage = errors.New("the database is not answering (a test fault)")

// faults is the set of operations that fail, each named as the operation
// and the table: "get settings", "update sessions", "count passkeys".
type faults struct {
	mu   sync.Mutex
	fail map[string]bool
}

func (f *faults) set(ops ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = map[string]bool{}
	for _, op := range ops {
		f.fail[op] = true
	}
}

func (f *faults) clear() { f.set() }

func (f *faults) check(op, table string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail[op+" "+table] {
		return errOutage
	}
	return nil
}

// tableOf names the table a row, or a pointer to one, is stored in.
func tableOf(row any) string {
	t := reflect.TypeOf(row)
	for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice {
		t = t.Elem()
	}
	if tb, ok := store.TableOf(t); ok {
		return tb.Name
	}
	return ""
}

// faultyDB is a store.DB whose operations fail when the faults say so.
type faultyDB struct {
	store.DB
	faults *faults
}

func (d faultyDB) Get(ctx context.Context, dst any, where ...store.Cond) error {
	if err := d.faults.check("get", tableOf(dst)); err != nil {
		return err
	}
	return d.DB.Get(ctx, dst, where...)
}

func (d faultyDB) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if err := d.faults.check("count", table); err != nil {
		return 0, err
	}
	return d.DB.Count(ctx, table, where...)
}

func (d faultyDB) Upsert(ctx context.Context, row any, key ...string) error {
	if err := d.faults.check("upsert", tableOf(row)); err != nil {
		return err
	}
	return d.DB.Upsert(ctx, row, key...)
}

func (d faultyDB) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	if err := d.faults.check("update", table); err != nil {
		return 0, err
	}
	return d.DB.Update(ctx, table, set, where...)
}

func (d faultyDB) Incr(ctx context.Context, table, col string, n int64, where ...store.Cond) (int64, error) {
	if err := d.faults.check("incr", table); err != nil {
		return 0, err
	}
	return d.DB.Incr(ctx, table, col, n, where...)
}

// faultyStore is a store.Store that fails the operations its faults name,
// on the store itself, on a workspace's DB and inside Atomic.
type faultyStore struct {
	store.Store
	faults *faults
}

func newFaultyStore(st store.Store) *faultyStore {
	return &faultyStore{Store: st, faults: &faults{}}
}

func (s *faultyStore) db() faultyDB { return faultyDB{DB: s.Store, faults: s.faults} }

func (s *faultyStore) Get(ctx context.Context, dst any, where ...store.Cond) error {
	return s.db().Get(ctx, dst, where...)
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

func (s *faultyStore) In(workspaceID string) store.DB {
	return faultyDB{DB: s.Store.In(workspaceID), faults: s.faults}
}

func (s *faultyStore) Atomic(ctx context.Context, fn func(store.DB) error) error {
	return s.Store.Atomic(ctx, func(db store.DB) error { return fn(faultyDB{DB: db, faults: s.faults}) })
}

// failGet makes every Get of that kind of row fail until the test ends.
func failGet(t *testing.T, fs *faultyStore, row any) {
	t.Helper()
	fs.faults.set("get " + tableOf(row))
	t.Cleanup(fs.faults.clear)
}
