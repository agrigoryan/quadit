package engine_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestANewProjectStartsWithFiveStatuses: Backlog, Todo, In Progress, Done
// and Canceled, one of each type, in that order, new tasks in Todo. A task
// that waits on someone stays in its started status.
func TestANewProjectStartsWithFiveStatuses(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		pid := w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
		var statuses []core.Status
		if err := w.db().List(context.Background(), &statuses, store.Q{Where: []store.Cond{store.Eq("project_id", pid)}, Order: "rank"}); err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, s := range statuses {
			name := s.Name + " (" + s.Category + ")"
			if s.IsDefault {
				name += " default"
			}
			got = append(got, name)
		}
		want := []string{"Backlog (backlog)", "Todo (unstarted) default", "In Progress (started)", "Done (done)", "Canceled (canceled)"}
		if !slices.Equal(got, want) {
			t.Errorf("a new project's statuses:\n got  %v\n want %v", got, want)
		}
	})
}

// TestWaitingIsNoStatusType: a status is made or changed only into one of
// the five types, and a rule names only those; anything else, waiting
// included, is refused with the types allowed.
func TestWaitingIsNoStatusType(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		refusedAsType := func(field string, e *engine.Error) {
			t.Helper()
			if e.Field != field || !slices.Equal(e.Allowed, []string{"backlog", "unstarted", "started", "done", "canceled"}) {
				t.Errorf("refusal = %+v, want field %s with the five types allowed", e, field)
			}
		}
		refusedAsType("category", w.refused(engine.CodeInvalid, w.owner.ID, "status.create", M{"project": "SVA", "name": "Waiting", "category": "waiting"}))
		review := w.do(w.owner.ID, "status.create", M{"project": "SVA", "name": "Waiting", "category": "started"}).Ref
		refusedAsType("category", w.refused(engine.CodeInvalid, w.owner.ID, "status.update", M{"id": review, "category": "waiting"}))
		refusedAsType("match.to_category", w.refused(engine.CodeInvalid, w.owner.ID, "rule.create",
			M{"name": "r", "match": M{"to_category": "waiting"}, "action": M{"kind": core.RuleNotify, "user_id": "me"}}))
	})
}

// TestANewStatusGoesAfterTheLastOfItsType: made without a rank, a status
// goes after the last status of its type, or of a type before it, and
// before whatever comes next; whatever order the board's columns are in,
// as when an upgrade made a Waiting column placed after Canceled started.
func TestANewStatusGoesAfterTheLastOfItsType(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		pid := w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
		order := func() string {
			t.Helper()
			var statuses []core.Status
			if err := w.db().List(context.Background(), &statuses, store.Q{Where: []store.Cond{store.Eq("project_id", pid), store.Live}, Order: "rank"}); err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, s := range statuses {
				names = append(names, s.Name)
			}
			return strings.Join(names, ", ")
		}
		w.do(w.owner.ID, "status.create", M{"project": "SVA", "name": "Review", "category": "started"})
		if got := order(); got != "Backlog, Todo, In Progress, Review, Done, Canceled" {
			t.Errorf("in type order: %s", got)
		}
		// A started column placed after Canceled.
		var canceled core.Status
		if err := w.db().Get(context.Background(), &canceled, store.Eq("project_id", pid), store.Eq("name", "Canceled")); err != nil {
			t.Fatal(err)
		}
		w.do(w.owner.ID, "status.create", M{"project": "SVA", "name": "Blocked", "category": "started", "rank": rank.After(canceled.Rank)})
		w.do(w.owner.ID, "status.create", M{"project": "SVA", "name": "Polish", "category": "started"})
		w.do(w.owner.ID, "status.create", M{"project": "SVA", "name": "Icebox", "category": "backlog"})
		if got := order(); got != "Backlog, Icebox, Todo, In Progress, Review, Done, Canceled, Blocked, Polish" {
			t.Errorf("out of type order: %s", got)
		}
	})
}
