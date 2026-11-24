package server_test

import (
	"context"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestARunnersOpenRunCountsAsWorkWhileItIsOpen: a run Quadit's runner has
// open makes its agent working however long it takes; a session an agent
// recorded by hand stops counting after twelve hours.
func TestARunnersOpenRunCountsAsWorkWhileItIsOpen(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		key := r.task(t, nil)
		r.change(t, nil, r.claude, "session.start", M{"task": key, "state": "waiting", "program": "claude", "machine_id": "3f9c0a7d5e21b864",
			"machine_name": "Aram's MacBook Pro", "folder": "~/devel/game", "lease": r.lease, "item_seq": 1})
		r.change(t, nil, r.codex, "session.start", M{"task": key, "title": "By hand"})
		if _, err := st.Update(context.Background(), "agent_sessions", map[string]any{"started_at": time.Now().Add(-13 * time.Hour).UnixMilli()},
			store.Eq("task_id", r.taskID(t, key))); err != nil {
			t.Fatal(err)
		}
		var out struct {
			Agents []struct{ Handle, State, Task string }
		}
		r.call(t, r.owner, "", "GET", w+"/agents", nil, 200, &out)
		for _, a := range out.Agents {
			if a.Handle == "@claude" && (a.State != "working" || a.Task != key) || a.Handle == "@codex" && a.State == "working" {
				t.Errorf("%s is told %s on %q", a.Handle, a.State, a.Task)
			}
		}
	})
}
