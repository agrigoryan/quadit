package backup_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// errFault is what a failing store answers.
var errFault = errors.New("the database went away")

// failing is a store on which one kind of call on one table fails, in a
// write or outside one: op "count" is Count, op "write" is setting a row
// back from an archive (Load and Overwrite).
type failing struct {
	store.Store
	op, table string
}

func (s *failing) Write(ctx context.Context, workspaceID string, fn func(store.Tx) error) error {
	return s.Store.Write(ctx, workspaceID, func(tx store.Tx) error { return fn(&failingTx{Tx: tx, op: s.op, table: s.table}) })
}

func (s *failing) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if s.op == "count" && table == s.table {
		return 0, errFault
	}
	return s.Store.Count(ctx, table, where...)
}

func (s *failing) Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...store.Cond) error {
	if s.op == "write" && table == s.table {
		return errFault
	}
	return s.Store.Overwrite(ctx, table, row, keep, where...)
}

// failingTx is a failing store's write.
type failingTx struct {
	store.Tx
	op, table string
}

func (tx *failingTx) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if tx.op == "count" && table == tx.table {
		return 0, errFault
	}
	return tx.Tx.Count(ctx, table, where...)
}

func (tx *failingTx) Load(ctx context.Context, table string, rows []map[string]any) error {
	if tx.op == "write" && table == tx.table {
		return errFault
	}
	return tx.Tx.Load(ctx, table, rows)
}

func (tx *failingTx) Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...store.Cond) error {
	if tx.op == "write" && table == tx.table {
		return errFault
	}
	return tx.Tx.Overwrite(ctx, table, row, keep, where...)
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
		if _, err := backup.Write(ctx, st, files, nil, "test", &archive); err != nil {
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
				broken := &failing{Store: st, op: "count", table: c.table}
				if _, err := backup.RestoreItem(ctx, engine.New(broken, nil), files, bytes.NewReader(archive.Bytes()), c.item); err == nil {
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

// A task or page that cannot be brought back whole is not brought back in
// part: when one of its rows cannot be written, every row of the
// workspace, and its feed, is as it was before the attempt.
func TestRestoreItemIsAllOrNothing(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		files, _ := blob.NewDisk(t.TempDir())
		ws, owner, e := fill(t, st, files)
		do := func(typ string, args M) {
			t.Helper()
			raw, _ := json.Marshal(args)
			if _, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: typ, Args: raw}); err != nil {
				t.Fatalf("%s: %v", typ, err)
			}
		}
		page := docID(t, st, ws.ID, "Design")
		var archive bytes.Buffer
		if _, err := backup.Write(ctx, st, files, nil, "test", &archive); err != nil {
			t.Fatal(err)
		}
		// Both change after the backup, so a restore has something to set back.
		do("task.update", M{"id": "SVA-1", "title": "Edited after the backup"})
		do("doc.update", M{"id": page, "title": "Renamed after the backup"})
		do("doc.write", M{"doc": page, "markdown": "# Design\n\nRewritten.\n"})

		for name, c := range map[string]struct {
			table string // written after the item's own row
			item  backup.Item
		}{
			"a task": {"attachments", backup.Item{Workspace: "games", Kind: "task", Ref: "SVA-1"}},
			"a page": {"doc_blocks", backup.Item{Workspace: "games", Kind: "doc", Ref: page}},
		} {
			t.Run(name, func(t *testing.T) {
				before := snapshot(t, st)
				broken := &failing{Store: st, op: "write", table: c.table}
				if _, err := backup.RestoreItem(ctx, engine.New(broken, nil), files, bytes.NewReader(archive.Bytes()), c.item); !errors.Is(err, errFault) {
					t.Fatalf("restore with a failing write = %v, want the write's error", err)
				}
				if after := snapshot(t, st); after != before {
					t.Fatalf("a failed restore left the database changed:\nbefore %s\nafter  %s", before, after)
				}
			})
		}
	})
}

// snapshot is every row of every table, as sorted lines of text.
func snapshot(t *testing.T, st store.Store) string {
	t.Helper()
	var lines []string
	err := st.Snapshot(context.Background(), func(snap store.Snapshot) error {
		for _, tb := range store.Tables() {
			err := snap.Dump(context.Background(), tb.Name, func(row map[string]any) error {
				line, err := json.Marshal(row)
				lines = append(lines, tb.Name+" "+string(line))
				return err
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(lines)
	return strings.Join(lines, "\n")
}
