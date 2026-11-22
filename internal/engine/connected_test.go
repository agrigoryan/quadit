package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// member reads a member's row.
func (w *world) member(userID string) core.Member {
	w.t.Helper()
	var m core.Member
	if err := w.db().Get(context.Background(), &m, store.Eq("user_id", userID)); err != nil {
		w.t.Fatal(err)
	}
	return m
}

// connectedEvents counts the events of changes that said a member was
// connected.
func connectedEvents(res []*engine.Result) int {
	n := 0
	for _, r := range res {
		for _, ev := range r.Events {
			if data, err := ev.Payload(); err == nil && ev.Type == "member.updated" {
				if _, ok := data.Changes["connected_at"]; ok {
					n++
				}
			}
		}
	}
	return n
}

func TestAnAgentIsConnected(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		t.Run("by its first change, once, which tells the workspace", func(t *testing.T) {
			w := newWorld(t, st)
			coder := w.agent("coder")
			w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
			if at := w.member(coder).ConnectedAt; at != 0 {
				t.Fatalf("an agent made by a person is connected at %d before it did anything", at)
			}
			first := w.batch(coder, change("task.create", M{"project": "OPS", "title": "One"}), change("task.create", M{"project": "OPS", "title": "Two"}))
			if n := connectedEvents(first); n != 1 {
				t.Fatalf("the first batch said %d times that the agent is connected, want once", n)
			}
			at := w.member(coder).ConnectedAt
			if at == 0 {
				t.Fatal("the agent's change did not connect it")
			}
			if n := connectedEvents([]*engine.Result{w.do(coder, "task.create", M{"project": "OPS", "title": "Three"})}); n != 0 {
				t.Fatalf("a later change said %d times that the agent is connected", n)
			}
			if again := w.member(coder).ConnectedAt; again != at {
				t.Fatalf("a later change moved connected_at from %d to %d", at, again)
			}
		})
		t.Run("not by a person's change, nor a dry run", func(t *testing.T) {
			w := newWorld(t, st)
			coder := w.agent("coder")
			w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
			if at := w.member(w.owner.ID).ConnectedAt; at != 0 {
				t.Fatalf("a person is connected at %d", at)
			}
			if _, err := w.e.Batch(context.Background(), w.ws.ID, engine.Actor{UserID: coder}, []engine.Change{change("task.create", M{"project": "OPS", "title": "One"})}, true); err != nil {
				t.Fatal(err)
			}
			if at := w.member(coder).ConnectedAt; at != 0 {
				t.Fatalf("a dry run connected the agent at %d", at)
			}
		})
		t.Run("by a system write for it, once", func(t *testing.T) {
			w := newWorld(t, st)
			coder := w.agent("coder")
			connect := func() int {
				t.Helper()
				var seqs []int64
				err := w.e.System(context.Background(), w.ws.ID, coder, func(sys *engine.Sys) error {
					before := sys.Tx().Seq()
					if err := sys.Connected(); err != nil {
						return err
					}
					for s := before + 1; s <= sys.Tx().Seq(); s++ {
						seqs = append(seqs, s)
					}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				return len(seqs)
			}
			if n := connect(); n != 1 {
				t.Fatalf("connecting the agent wrote %d events, want 1", n)
			}
			at := w.member(coder).ConnectedAt
			if at == 0 {
				t.Fatal("the system write did not connect the agent")
			}
			if n := connect(); n != 0 {
				t.Fatalf("connecting it again wrote %d events, want none", n)
			}
			if again := w.member(coder).ConnectedAt; again != at {
				t.Fatalf("connecting it again moved connected_at from %d to %d", at, again)
			}
		})
	})
}
