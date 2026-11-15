package backup_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// countFails is a store whose first Count on one table fails, as a
// database that went away for a moment would.
type countFails struct {
	store.Store
	table  string
	failed bool
}

func (s *countFails) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if table == s.table && !s.failed {
		s.failed = true
		return 0, errors.New("the database went away")
	}
	return s.Store.Count(ctx, table, where...)
}

// A task or page whose parent cannot be looked up is not brought back
// cut loose from it: the restore stops and says why.
func TestRestoreItemStopsWhenItsParentCannotBeLookedUp(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		files, _ := blob.NewDisk(t.TempDir())
		ws, owner, e := fill(t, st, files)
		raw, _ := json.Marshal(M{"title": "Child page", "markdown": "under Design", "parent": docID(t, st, ws.ID, "Design")})
		child, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "doc.create", Args: raw})
		if err != nil {
			t.Fatal(err)
		}
		var archive bytes.Buffer
		if _, err := backup.Write(ctx, st, files, "test", &archive); err != nil {
			t.Fatal(err)
		}
		for name, c := range map[string]struct {
			table string
			item  backup.Item
		}{
			"a sub-task": {"tasks", backup.Item{Workspace: "games", Kind: "task", Ref: "SVA-2"}},
			"a sub-page": {"docs", backup.Item{Workspace: "games", Kind: "doc", Ref: child.Ref}},
		} {
			t.Run(name, func(t *testing.T) {
				failing := &countFails{Store: st, table: c.table}
				if _, err := backup.RestoreItem(ctx, failing, files, bytes.NewReader(archive.Bytes()), c.item); err == nil {
					t.Fatal("restored with no error while its parent could not be looked up")
				}
			})
		}
	})
}

// docID is the id of the page with that title.
func docID(t *testing.T, st store.Store, wsID, title string) string {
	t.Helper()
	var d core.Doc
	if err := st.In(wsID).Get(context.Background(), &d, store.Eq("title", title)); err != nil {
		t.Fatal(err)
	}
	return d.ID
}
