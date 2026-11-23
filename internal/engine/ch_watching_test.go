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

// TestAnAgentFollowsOnlyWhatItChoseTo: what a person does on a task or a
// page (making it, being given it, being mentioned, commenting, asking or
// answering a question) makes them follow it; the same done by or to an
// agent does not, so it is not woken for every later comment there. An
// agent that follows by choice hears all of it.
func TestAnAgentFollowsOnlyWhatItChoseTo(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		mia := w.person("mia")
		maker, coder, named, writer, asker := w.agent("maker"), w.agent("coder"), w.agent("named"), w.agent("writer"), w.agent("asker")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(maker, "task.create", M{"project": "SVA", "title": "Boss fight", "assignee": "@coder", "description": "@named and @mia know the boss."})
		w.do(writer, "comment.create", M{"task": "SVA-1", "body": "Looks right."})
		w.do(w.owner.ID, "comment.create", M{"task": "SVA-1", "body": "@writer and @mia, have a look."})
		w.do(asker, "decision.open", M{"task": "SVA-1", "question": "Which arena?", "options": []M{{"label": "Roof"}, {"label": "Dojo"}}})
		page := w.do(writer, "doc.create", M{"title": "Boss notes"}).Ref
		w.do(writer, "comment.create", M{"doc": page, "body": "Draft."})
		task := w.task("SVA-1").ID

		follows := func(userID, subject string) bool {
			t.Helper()
			n, err := w.db().Count(context.Background(), "watchers", store.Eq("subject_id", subject), store.Eq("user_id", userID))
			if err != nil {
				t.Fatal(err)
			}
			return n > 0
		}
		for who, id := range map[string]string{"its maker": maker, "its assignee": coder, "one its description mentions": named,
			"one who commented": writer, "one a comment mentions": writer, "one who asked a question": asker} {
			if follows(id, task) {
				t.Errorf("%s, an agent, follows the task", who)
			}
		}
		if follows(writer, page) {
			t.Error("an agent that made a page and commented on it follows the page")
		}
		if !follows(mia, task) {
			t.Error("a person mentioned on the task does not follow it")
		}
		if !follows(w.owner.ID, task) {
			t.Error("a person who commented on the task does not follow it")
		}

		t.Run("an agent that follows by choice hears every comment", func(t *testing.T) {
			w.do(coder, "watch.set", M{"subject": "SVA-1"})
			before := len(w.inbox(coder))
			w.do(w.owner.ID, "comment.create", M{"task": "SVA-1", "body": "@mia what do you think?"})
			w.do(writer, "comment.create", M{"task": "SVA-1", "body": "The roof, I think."})
			if got := len(w.inbox(coder)) - before; got != 2 {
				t.Fatalf("the agent following the task by choice got %d items for two comments, want 2", got)
			}
		})
	})
}
