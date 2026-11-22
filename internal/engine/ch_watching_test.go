package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAMemberWatchesOnlyWhatTheyMaySee: a member cannot follow a task, an
// epic, a project, a saved view or a page they may not see, whoever asks;
// and following is recorded in the project of what is followed, so a
// token kept to other projects is not told of it.
func TestAMemberWatchesOnlyWhatTheyMaySee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		narrow := w.do(w.owner.ID, "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}}).Ref
		w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Rotate keys"})
		opsView := w.do(w.owner.ID, "view.create", M{"name": "Ops board", "project": "OPS"}).Ref
		opsPage := w.do(w.owner.ID, "doc.create", M{"title": "Runbook", "project": "OPS"}).Ref
		privatePage := w.do(w.owner.ID, "doc.create", M{"title": "Diary", "private": true}).Ref
		epic := w.do(w.owner.ID, "epic.create", M{"project": "OPS", "name": "Hardening"}).Ref

		for _, hidden := range []M{
			{"type": "task", "subject": "OPS-1"},
			{"type": "epic", "subject": epic},
			{"type": "project", "subject": "OPS"},
			{"type": "view", "subject": opsView},
			{"type": "doc", "subject": opsPage},
			{"type": "doc", "subject": privatePage},
		} {
			w.refused(engine.CodeForbidden, narrow, "watch.set", hidden)
			hidden["user"] = "@narrow"
			if e := w.refused(engine.CodeInvalid, w.owner.ID, "watch.set", hidden); e.Field != "user" {
				t.Errorf("making @narrow follow %v is refused for %q, want user", hidden, e.Field)
			}
		}

		w.do(w.owner.ID, "watch.set", M{"type": "view", "subject": opsView})
		w.do(w.owner.ID, "watch.set", M{"type": "doc", "subject": opsPage, "watching": false}) // its writer follows it from the start
		w.do(w.owner.ID, "watch.set", M{"type": "doc", "subject": opsPage})
		evs, err := w.db().Events(context.Background(), store.EventFilter{Types: []string{"watcher.created", "watcher.deleted"}})
		if err != nil {
			t.Fatal(err)
		}
		var opsProject string
		for _, ev := range evs {
			if opsProject == "" {
				opsProject = ev.ProjectID
			}
			if ev.ProjectID == "" || ev.ProjectID != opsProject {
				t.Errorf("following %s %s is recorded in project %q, not in the project of what is followed", ev.ScopeType, ev.EntityID, ev.ProjectID)
			}
		}
		if len(evs) != 3 {
			t.Fatalf("want 3 watcher events, got %d", len(evs))
		}

		// Stopping is always allowed, and following what the member may see
		// still works.
		w.do(w.owner.ID, "watch.set", M{"type": "view", "subject": opsView, "watching": false})
		w.do(narrow, "watch.set", M{"type": "project", "subject": "SVA"})
	})
}
