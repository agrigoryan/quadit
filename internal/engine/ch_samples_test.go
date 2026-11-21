package engine_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// project reads a project by id, in the trash or not.
func (w *world) project(projectID string) core.Project {
	w.t.Helper()
	var p core.Project
	if err := w.db().Get(context.Background(), &p, store.Eq("id", projectID)); err != nil {
		w.t.Fatalf("project %s: %v", projectID, err)
	}
	return p
}

// samples are the sample tasks of a project, in order.
func (w *world) samples(projectID string) []core.Task {
	w.t.Helper()
	var out []core.Task
	for _, taskID := range w.project(projectID).Samples {
		out = append(out, w.task(taskID))
	}
	return out
}

// labelNames are the names of a task's labels.
func (w *world) labelNames(t core.Task) []string {
	w.t.Helper()
	var labels []core.Label
	if err := w.db().List(context.Background(), &labels, store.Q{Where: []store.Cond{store.In("id", t.LabelIDs)}}); err != nil {
		w.t.Fatal(err)
	}
	names := make([]string, len(labels))
	for i, l := range labels {
		names[i] = l.Name
	}
	return names
}

// TestSamplesAddMakesGettingStarted: the samples are a project "Getting
// started" (GS) with three tasks marked Sample, the first two for the one
// who asked and the third for the agent named or nobody, remembered on the
// project in that order.
func TestSamplesAddMakesGettingStarted(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		coder := w.agent("coder")
		res := w.do(w.owner.ID, "samples.add", M{"agent": "@coder"})
		p := w.project(res.Ref)
		if p.Key != "GS" || p.Name != "Getting started" || res.Key != "GS" {
			t.Fatalf("the samples' project is %s %q", p.Key, p.Name)
		}
		tasks := w.samples(p.ID)
		want := []struct{ key, title, assignee string }{
			{"GS-1", "Open this task and leave a comment", w.owner.ID},
			{"GS-2", "Write a page in Docs about what you are working on", w.owner.ID},
			{"GS-3", "Say hello and tell Aram what you can do", coder},
		}
		if len(tasks) != len(want) {
			t.Fatalf("%d sample tasks, want %d", len(tasks), len(want))
		}
		for i, wt := range want {
			got := tasks[i]
			if got.Key != wt.key || got.Title != wt.title || got.AssigneeID != wt.assignee || got.ProjectID != p.ID {
				t.Errorf("sample %d is %s %q for %q, want %s %q for %q", i+1, got.Key, got.Title, got.AssigneeID, wt.key, wt.title, wt.assignee)
			}
			if names := w.labelNames(got); !slices.Equal(names, []string{"Sample"}) {
				t.Errorf("%s has the labels %v", got.Key, names)
			}
		}
		if n := w.inbox(coder); len(n) != 1 || n[0].Type != core.NoteAssigned {
			t.Fatalf("the agent was told %+v, want that GS-3 is its", n)
		}

		t.Run("without an agent the third is nobody's", func(t *testing.T) {
			w := newWorld(t, st)
			res := w.do(w.owner.ID, "samples.add", M{})
			if third := w.samples(res.Ref)[2]; third.AssigneeID != "" {
				t.Fatalf("the third sample is for %q", third.AssigneeID)
			}
		})
	})
}

// TestSamplesAddTwiceIsOnce: while the samples are there, asking again
// makes nothing; it gives the third to an agent only while it has nobody.
func TestSamplesAddTwiceIsOnce(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		coder := w.agent("coder")
		w.agent("writer")
		first := w.do(w.owner.ID, "samples.add", M{})
		count := func() int {
			n, err := w.db().Count(context.Background(), "tasks")
			if err != nil {
				t.Fatal(err)
			}
			return n
		}

		again := w.do(w.owner.ID, "samples.add", M{})
		if again.Ref != first.Ref || again.Key != "GS" || len(again.Events) != 0 || count() != 3 {
			t.Fatalf("asking again answered %s with %d events and left %d tasks", again.Ref, len(again.Events), count())
		}
		given := w.do(w.owner.ID, "samples.add", M{"agent": coder})
		if given.Ref != first.Ref || w.samples(first.Ref)[2].AssigneeID != coder || count() != 3 {
			t.Fatal("naming an agent did not give it the third sample")
		}
		other := w.do(w.owner.ID, "samples.add", M{"agent": "@writer"})
		if len(other.Events) != 0 || w.samples(first.Ref)[2].AssigneeID != coder {
			t.Fatal("a second agent took the third sample from the first")
		}

		t.Run("a third task given away by hand stays", func(t *testing.T) {
			w := newWorld(t, st)
			w.agent("coder")
			made := w.do(w.owner.ID, "samples.add", M{})
			third := w.samples(made.Ref)[2]
			w.do(w.owner.ID, "task.update", M{"id": third.ID, "assignee": "me"})
			w.do(w.owner.ID, "samples.add", M{"agent": "@coder"})
			if got := w.task(third.ID).AssigneeID; got != w.owner.ID {
				t.Fatalf("the third sample went to %q", got)
			}
		})
	})
}

// TestSamplesAreForPeopleWhoAdministerAndTheThirdForAnAgent: only a person
// who is an owner or admin, with a credential that reaches the samples'
// project, may add or remove them, and the third goes only to an agent of
// the workspace.
func TestSamplesAreForPeopleWhoAdministerAndTheThirdForAnAgent(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		mia := core.User{ID: id.New(), Kind: core.KindPerson, Name: "Mia", Email: "mia-" + id.New() + "@example.com", CreatedAt: 1, UpdatedAt: 1}
		if err := st.Insert(ctx, mia); err != nil {
			t.Fatal(err)
		}
		w.do(w.owner.ID, "member.add", M{"user": mia.ID, "handle": "mia", "role": "member"})

		w.refused(engine.CodeForbidden, mia.ID, "samples.add", M{})
		w.refused(engine.CodeForbidden, mia.ID, "samples.remove", M{})
		if e := w.refused(engine.CodeInvalid, w.owner.ID, "samples.add", M{"agent": "@mia"}); e.Field != "agent" {
			t.Fatalf("a person as the agent: %v", e)
		}
		if e := w.refused(engine.CodeInvalid, w.owner.ID, "samples.add", M{"agent": "@nobody"}); e.Field != "agent" {
			t.Fatalf("an agent who is not here: %v", e)
		}
		if n, err := w.db().Count(ctx, "projects"); err != nil || n != 0 {
			t.Fatalf("refusals left %d projects (%v)", n, err)
		}

		t.Run("an agent, even an admin, may not", func(t *testing.T) {
			bot := w.do(w.owner.ID, "agent.create", M{"name": "Ops", "handle": "ops", "role": "admin"}).Ref
			w.refused(engine.CodeForbidden, bot, "samples.add", M{})
			w.do(w.owner.ID, "samples.add", M{})
			w.refused(engine.CodeForbidden, bot, "samples.add", M{})
			w.refused(engine.CodeForbidden, bot, "samples.remove", M{})
		})

		t.Run("a credential kept to other projects learns nothing of them", func(t *testing.T) {
			other := w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
			narrow := engine.Actor{UserID: w.owner.ID, Projects: []string{other}}
			for _, typ := range []string{"samples.add", "samples.remove"} {
				_, err := w.e.Apply(ctx, w.ws.ID, narrow, change(typ, M{}))
				if refusal, ok := errors.AsType[*engine.Error](err); !ok || refusal.Code != engine.CodeForbidden {
					t.Fatalf("%s with a credential kept to SVA: %v", typ, err)
				}
			}
		})
	})
}

// TestSamplesTakeTheNextFreeKey: a project with the key GS, in the trash or
// not, leaves the samples the next free key.
func TestSamplesTakeTheNextFreeKey(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "GS", "name": "Game studio"})
		if got := w.do(w.owner.ID, "samples.add", M{}).Key; got != "GS2" {
			t.Fatalf("the samples beside a project GS have the key %s", got)
		}
		w.do(w.owner.ID, "samples.remove", M{})
		if got := w.do(w.owner.ID, "samples.add", M{}).Key; got != "GS3" {
			t.Fatalf("the samples after a removed GS2 have the key %s", got)
		}
	})
}

// TestSamplesRemoveLeavesThePersonsOwnWork: removing the samples sends the
// ones left to the trash, as a person's delete does, and their project
// with them unless something of the person's own is in it.
func TestSamplesRemoveLeavesThePersonsOwnWork(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		t.Run("alone", func(t *testing.T) {
			w := newWorld(t, st)
			made := w.do(w.owner.ID, "samples.add", M{})
			first := w.samples(made.Ref)[0]
			w.do(w.owner.ID, "task.delete", M{"id": first.ID})
			w.do(w.owner.ID, "samples.remove", M{})
			for _, s := range w.samples(made.Ref) {
				if s.DeletedAt == 0 || s.DeletedBy != w.owner.ID {
					t.Fatalf("%s is not in the trash as the owner's delete", s.Key)
				}
			}
			if w.project(made.Ref).DeletedAt == 0 {
				t.Fatal("the empty project stayed")
			}
			// Asked again with nothing left, it is done already.
			if res := w.do(w.owner.ID, "samples.remove", M{}); len(res.Events) != 0 {
				t.Fatalf("removing no samples wrote %d events", len(res.Events))
			}
		})

		t.Run("with a task of the person's own", func(t *testing.T) {
			w := newWorld(t, st)
			made := w.do(w.owner.ID, "samples.add", M{})
			mine := w.do(w.owner.ID, "task.create", M{"project": "GS", "title": "Plan the launch"}).Ref
			w.do(w.owner.ID, "samples.remove", M{})
			if w.task(mine).DeletedAt != 0 || w.project(made.Ref).DeletedAt != 0 {
				t.Fatal("the person's own task, or the project it is in, went to the trash")
			}
			for _, s := range w.samples(made.Ref) {
				if s.DeletedAt == 0 {
					t.Fatalf("%s stayed", s.Key)
				}
			}
			// The samples are gone, so asking for them makes new ones.
			if again := w.do(w.owner.ID, "samples.add", M{}); again.Ref == made.Ref {
				t.Fatal("asking after a removal answered with the removed samples")
			}
		})

		// Whatever else a person can put in a project keeps it: each kind of
		// row that belongs to a project, made after the samples, or a status
		// or the label the samples came with, changed since.
		for what, add := range map[string]func(w *world){
			"a page":  func(w *world) { w.do(w.owner.ID, "doc.create", M{"title": "What I am working on", "project": "GS"}) },
			"an epic": func(w *world) { w.do(w.owner.ID, "epic.create", M{"project": "GS", "name": "Launch"}) },
			"a cycle": func(w *world) {
				w.do(w.owner.ID, "cycle.create", M{"project": "GS", "starts_on": "2026-12-01", "ends_on": "2026-12-07"})
			},
			"a view": func(w *world) {
				w.do(w.owner.ID, "view.create", M{"name": "Mine", "project": "GS", "query": M{"assignee": []string{"me"}}})
			},
			"a template": func(w *world) {
				w.do(w.owner.ID, "template.create", M{"project": "GS", "name": "Bug", "title": "Bug: "})
			},
			"a preference": func(w *world) { w.do(w.owner.ID, "preference.create", M{"body": "Write short.", "project": "GS"}) },
			"a status": func(w *world) {
				w.do(w.owner.ID, "status.create", M{"project": "GS", "name": "Review", "category": "started"})
			},
			"a label": func(w *world) { w.do(w.owner.ID, "label.create", M{"project": "GS", "name": "bug"}) },
			"a status renamed": func(w *world) {
				w.do(w.owner.ID, "status.update", M{"id": "Todo", "name": "To do"})
			},
			"the label recoloured": func(w *world) { w.do(w.owner.ID, "label.update", M{"id": "Sample", "color": "#ff0000"}) },
			"a webhook": func(w *world) {
				w.do(w.owner.ID, "webhook.create", M{"name": "out", "url": "https://example.com/hook", "project": "GS"})
			},
			"an integration": func(w *world) {
				w.do(w.owner.ID, "integration.create", M{"kind": "github", "name": "gh", "project": "GS"})
			},
			"a rule": func(w *world) {
				gs := w.project(w.do(w.owner.ID, "samples.add", M{}).Ref)
				w.do(w.owner.ID, "rule.create", M{"name": "Ping", "match": M{"event_types": []string{"task.updated"}, "project_id": gs.ID},
					"action": M{"kind": "notify", "user_id": w.owner.ID, "message": "x"}})
			},
		} {
			t.Run("with "+what+" of the person's own", func(t *testing.T) {
				w := newWorld(t, st)
				made := w.do(w.owner.ID, "samples.add", M{})
				add(w)
				w.do(w.owner.ID, "samples.remove", M{})
				if w.project(made.Ref).DeletedAt != 0 {
					t.Fatalf("the project with %s of the person's own in it went to the trash", what)
				}
			})
		}

		t.Run("a sample moved to another project is the person's", func(t *testing.T) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			made := w.do(w.owner.ID, "samples.add", M{})
			moved := w.samples(made.Ref)[0].ID
			w.do(w.owner.ID, "task.move", M{"id": moved, "project": "SVA"})
			w.do(w.owner.ID, "samples.remove", M{})
			if w.task(moved).DeletedAt != 0 {
				t.Fatal("a sample moved to another project went to the trash with the samples")
			}
			if w.project(made.Ref).DeletedAt == 0 {
				t.Fatal("the project the samples were in stayed, with only them in it")
			}
		})

		t.Run("samples moved away are not there", func(t *testing.T) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			made := w.do(w.owner.ID, "samples.add", M{})
			for _, s := range w.samples(made.Ref) {
				w.do(w.owner.ID, "task.move", M{"id": s.ID, "project": "SVA"})
			}
			if again := w.do(w.owner.ID, "samples.add", M{}); again.Ref == made.Ref {
				t.Fatal("samples all moved to another project were taken for samples still there")
			}
		})
	})
}

// TestSettingAnInstallUpMakesTheSamples: the workspace an install is set up
// with has the samples from its first moment, the third for nobody.
func TestSettingAnInstallUpMakesTheSamples(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		e := engine.New(st, nil)
		ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram Grigoryan", WorkspaceSlug: "personal", WorkspaceName: "Personal", Install: true})
		if err != nil {
			t.Fatal(err)
		}
		w := &world{t: t, e: e, st: st, ws: ws, owner: owner}
		var projects []core.Project
		if err := w.db().List(ctx, &projects, store.Q{}); err != nil || len(projects) != 1 {
			t.Fatalf("the new workspace has %d projects (%v)", len(projects), err)
		}
		tasks := w.samples(projects[0].ID)
		if len(tasks) != 3 || tasks[0].AssigneeID != owner.ID || tasks[2].AssigneeID != "" || tasks[2].Title != "Say hello and tell Aram what you can do" {
			t.Fatalf("the new workspace's samples are %+v", tasks)
		}
		if again := w.do(owner.ID, "samples.add", M{}); again.Ref != projects[0].ID {
			t.Fatal("the samples made with the workspace are not found again")
		}

		t.Run("a workspace made later starts empty", func(t *testing.T) {
			later, _, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerID: owner.ID, WorkspaceSlug: "later", WorkspaceName: "Later"})
			if err != nil {
				t.Fatal(err)
			}
			if n, err := st.In(later.ID).Count(ctx, "projects"); err != nil || n != 0 {
				t.Fatalf("a workspace made later has %d projects (%v)", n, err)
			}
		})
	})
}

// TestAnInstallIsSetUpOnce: setting an install up is refused once it has
// a person, and of two set-ups at once one is.
func TestAnInstallIsSetUpOnce(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		e := engine.New(st, nil)
		setUp := func(slug string) error {
			_, _, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", WorkspaceSlug: slug, WorkspaceName: slug, Install: true})
			return err
		}
		refusedAsSetUp := func(err error) bool {
			refusal, ok := errors.AsType[*engine.Error](err)
			return ok && refusal.Code == engine.CodeConflict
		}

		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i := range errs {
			wg.Go(func() { errs[i] = setUp(fmt.Sprintf("first-%d", i)) })
		}
		wg.Wait()
		if (errs[0] == nil) == (errs[1] == nil) || !refusedAsSetUp(errors.Join(errs[0], errs[1])) {
			t.Fatalf("two set-ups at once ended %v and %v, want one set up and one refused", errs[0], errs[1])
		}
		if err := setUp("again"); !refusedAsSetUp(err) {
			t.Fatalf("setting a set-up install up again: %v", err)
		}
		if n, err := st.Count(ctx, "users", store.Eq("kind", core.KindPerson)); err != nil || n != 1 {
			t.Fatalf("the install has %d people (%v), want its one owner", n, err)
		}
	})
}
