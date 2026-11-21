package sqlstore

import (
	"context"
	"errors"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// TestCreateWorkspaceIsOneWrite: a workspace made with CreateWorkspace is
// there with what was written to it and the event numbers it handed out,
// or, when the write fails or its address is taken, not at all.
func TestCreateWorkspaceIsOneWrite(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		// A project names who made it, and Postgres holds it to a person who is there.
		me := id.New()
		if err := s.Insert(ctx, core.User{ID: me, Kind: "person", Name: "Me", Email: me + "@example.com", CreatedAt: 1, UpdatedAt: 1}); err != nil {
			t.Fatal(err)
		}
		newWorkspace := func(slug string) core.Workspace {
			return core.Workspace{ID: id.New(), Slug: slug, Name: slug, CreatedAt: 1, UpdatedAt: 1}
		}
		count := func(table string, where ...store.Cond) int {
			t.Helper()
			n, err := s.Count(ctx, table, where...)
			if err != nil {
				t.Fatal(err)
			}
			return n
		}

		t.Run("written whole", func(t *testing.T) {
			ws := newWorkspace("made")
			err := s.CreateWorkspace(ctx, ws, func(tx store.Tx) error {
				if tx.WorkspaceID() != ws.ID {
					t.Fatalf("the write is to %s, want %s", tx.WorkspaceID(), ws.ID)
				}
				seq := tx.NextSeq()
				return tx.Insert(ctx, core.Project{ID: id.New(), Key: "GS", Name: "Getting started", CreatedBy: me, CreatedAt: 1, UpdatedAt: 1, CreatedSeq: seq, UpdatedSeq: seq})
			})
			if err != nil {
				t.Fatal(err)
			}
			var got core.Workspace
			if err := s.Get(ctx, &got, store.Eq("id", ws.ID)); err != nil || got.Seq != 1 {
				t.Fatalf("the workspace is %+v (%v), want it at event 1", got, err)
			}
			if count("projects", store.Eq("workspace_id", ws.ID)) != 1 {
				t.Fatal("what was written with the workspace is not there")
			}
		})

		t.Run("a failed write leaves nothing", func(t *testing.T) {
			ws := newWorkspace("failed")
			broke := errors.New("broke")
			err := s.CreateWorkspace(ctx, ws, func(tx store.Tx) error {
				if err := tx.Insert(ctx, core.Project{ID: id.New(), Key: "GS", Name: "Getting started", CreatedBy: me, CreatedAt: 1, UpdatedAt: 1}); err != nil {
					return err
				}
				return broke
			})
			if !errors.Is(err, broke) {
				t.Fatalf("the write's error is %v", err)
			}
			if count("workspaces", store.Eq("id", ws.ID)) != 0 || count("projects", store.Eq("workspace_id", ws.ID)) != 0 {
				t.Fatal("a failed write left the workspace or its rows behind")
			}
		})

		t.Run("a taken address", func(t *testing.T) {
			ran := false
			err := s.CreateWorkspace(ctx, newWorkspace("made"), func(store.Tx) error { ran = true; return nil })
			if !errors.Is(err, store.ErrConflict) || ran {
				t.Fatalf("a second workspace at the same address: %v (the write ran: %v)", err, ran)
			}
		})
	})
}
