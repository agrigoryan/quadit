package server_test

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// errDatabaseDown is what a store that has lost its database answers.
var errDatabaseDown = errors.New("the database is not answering")

// faultyStore is a store whose Get fails, when told to, for one kind of
// row: in the store itself and in the databases bound to a workspace.
type faultyStore struct {
	store.Store
	mu      sync.Mutex
	failing reflect.Type // the row type whose Get fails; nil for none
}

// failGetOf makes every Get into a *T fail until the test ends.
func failGetOf[T any](t *testing.T, fs *faultyStore) {
	t.Helper()
	fs.mu.Lock()
	fs.failing = reflect.TypeFor[*T]()
	fs.mu.Unlock()
	t.Cleanup(func() {
		fs.mu.Lock()
		fs.failing = nil
		fs.mu.Unlock()
	})
}

func (fs *faultyStore) fails(dst any) bool {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.failing != nil && reflect.TypeOf(dst) == fs.failing
}

func (fs *faultyStore) Get(ctx context.Context, dst any, where ...store.Cond) error {
	if fs.fails(dst) {
		return errDatabaseDown
	}
	return fs.Store.Get(ctx, dst, where...)
}

func (fs *faultyStore) In(workspaceID string) store.DB {
	return faultyDB{DB: fs.Store.In(workspaceID), fs: fs}
}

// faultyDB is a workspace's database in a faultyStore.
type faultyDB struct {
	store.DB
	fs *faultyStore
}

func (db faultyDB) Get(ctx context.Context, dst any, where ...store.Cond) error {
	if db.fs.fails(dst) {
		return errDatabaseDown
	}
	return db.DB.Get(ctx, dst, where...)
}

// TestSignInDoesNotTakeAnOutageForARefusal checks that when the database
// fails while the server finds who is asking and in which workspace, the
// caller is told the server failed (500), not that their token, session
// or workspace is not valid (401, 404): a database outage is never
// answered as "not found".
func TestSignInDoesNotTakeAnOutageForARefusal(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := &faultyStore{Store: st}
		s := newSite(t, fs)
		token := s.agentToken("bot")

		// Each case makes one kind of row unreadable and calls the API.
		cases := []struct {
			name   string
			fail   func(t *testing.T)
			client *http.Client
			token  string
		}{
			{"the token", func(t *testing.T) { failGetOf[core.APIToken](t, fs) }, nil, token},
			{"the token's account", func(t *testing.T) { failGetOf[core.User](t, fs) }, nil, token},
			{"the session", func(t *testing.T) { failGetOf[core.Session](t, fs) }, s.owner, ""},
			{"the session's account", func(t *testing.T) { failGetOf[core.User](t, fs) }, s.owner, ""},
			{"the workspace", func(t *testing.T) { failGetOf[core.Workspace](t, fs) }, nil, token},
			{"the membership", func(t *testing.T) { failGetOf[core.Member](t, fs) }, nil, token},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				parent := s.t
				s.t = t // call reports to this case
				defer func() { s.t = parent }()
				tc.fail(t)
				body := s.call(tc.client, tc.token, "GET", w+"/me", nil, 500, nil)
				if !strings.Contains(body, `"code":"internal"`) {
					t.Fatalf("the answer is not the server's own failure: %s", body)
				}
			})
		}
	})
}
