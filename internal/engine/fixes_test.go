package engine_test

import (
	"context"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// sameRefusal sends one refused change many times and fails unless every
// refusal says the same.
func (w *world) sameRefusal(code, userID, typ string, args any) string {
	w.t.Helper()
	seen := map[string]bool{}
	for range 40 {
		e := w.refused(code, userID, typ, args)
		seen[e.Error()] = true
	}
	if len(seen) != 1 {
		w.t.Fatalf("%s: the same request was refused %d different ways: %v", typ, len(seen), seen)
	}
	for msg := range seen {
		return msg
	}
	return ""
}

func TestViewWithTwoWrongPeopleIsAlwaysToldTheSame(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		got := w.sameRefusal(engine.CodeInvalid, w.owner.ID, "view.create", M{"name": "Mine",
			"query": M{"assignee": []string{"ghost-a"}, "creator": "ghost-b", "asked": "ghost-c", "mentions": "ghost-d"}})
		// The first filter as the query declares them is the one named.
		if !strings.Contains(got, "ghost-a") {
			t.Fatalf("refusal = %s, want it to name the assignee", got)
		}
	})
}

func TestRowWithTwoWrongValuesIsAlwaysToldTheSame(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		db := w.do(w.owner.ID, "doc.create", M{"title": "Sprites", "kind": "database"}).Ref
		w.do(w.owner.ID, "property.create", M{"database": db, "name": "Frames", "type": "number"})
		w.do(w.owner.ID, "property.create", M{"database": db, "name": "Done", "type": "checkbox"})
		w.sameRefusal(engine.CodeInvalid, w.owner.ID, "doc.create", M{"parent": db, "title": "Idle",
			"props": M{"Nope": 1, "Zilch": 2, "Nada": 3, "Frames": "many", "Done": "yes"}})
		w.sameRefusal(engine.CodeInvalid, w.owner.ID, "doc.create", M{"parent": db, "title": "Idle",
			"props": M{"Frames": "many", "Done": "yes"}})
	})
}

func TestStaleUpdateListsTheChangedFieldsInOneOrder(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion"})
		base := w.task("SVA-1").UpdatedSeq
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "title": "Big explosion", "description": "boom", "priority": 2})
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "estimate": 3, "due_on": "2030-01-02"})
		w.sameRefusal(engine.CodeStale, w.owner.ID, "task.update", M{"id": "SVA-1", "title": "Mine", "base_seq": base})
	})
}

// A change that would break a uniqueness rule names the value asked for,
// the same as when the thing is created with it.
func TestTakenUpdateNamesTheValue(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "ALP", "name": "Alpha"})
		beta := w.do(w.owner.ID, "project.create", M{"key": "BET", "name": "Beta"}).Ref
		created := w.refused(engine.CodeConflict, w.owner.ID, "project.create", M{"key": "ALP", "name": "Again"})
		updated := w.refused(engine.CodeConflict, w.owner.ID, "project.update", M{"id": beta, "key": "alp"})
		if want := `project key "ALP" is already in use`; created.Message != want || updated.Message != want {
			t.Errorf("create said %q, update said %q; both should say %q", created.Message, updated.Message, want)
		}

		var done core.Status
		if err := w.db().Get(context.Background(), &done, store.Eq("project_id", beta), store.Eq("name", "Done")); err != nil {
			t.Fatal(err)
		}
		e := w.refused(engine.CodeConflict, w.owner.ID, "status.update", M{"id": done.ID, "name": "Canceled"})
		if want := `status name "Canceled" is already in use`; e.Message != want {
			t.Errorf("status.update said %q, want %q", e.Message, want)
		}

		w.agent("artist")
		e = w.refused(engine.CodeConflict, w.owner.ID, "member.update", M{"id": w.owner.ID, "handle": "artist"})
		if want := "the handle @artist is taken"; e.Message != want {
			t.Errorf("member.update said %q, want %q", e.Message, want)
		}
	})
}
