package engine_test

import (
	"errors"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTaskCreateNamesTheFirstThingWrong pins the order task.create checks
// its arguments in: a request wrong in many ways is told about the first,
// and once that is put right, about the next.
func TestTaskCreateNamesTheFirstThingWrong(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		args := M{"project": "SVA", "parent": "SVA-99", "template": "nope", "title": " ", "priority": 9, "estimate": -1,
			"status": "nope", "assignee": "@nobody", "waiting_on": "@nobody", "due_on": "someday", "labels": []string{"nope"},
			"epic": "nope", "milestone": "nope", "cycle": "nope", "number": -1, "rank": "!"}
		// Each wrong argument, in the order it is reported, with what puts it right.
		order := []struct {
			field string
			fix   func()
		}{
			{"parent", func() { delete(args, "parent") }},
			{"template", func() { delete(args, "template") }},
			{"title", func() { args["title"] = "Jump" }},
			{"priority", func() { delete(args, "priority") }},
			{"estimate", func() { delete(args, "estimate") }},
			{"status", func() { delete(args, "status") }},
			{"assignee", func() { delete(args, "assignee") }},
			{"waiting_on", func() { delete(args, "waiting_on") }},
			{"due_on", func() { delete(args, "due_on") }},
			{"labels", func() { delete(args, "labels") }},
			{"epic", func() { delete(args, "epic") }},
			{"milestone", func() { delete(args, "milestone") }},
			{"cycle", func() { delete(args, "cycle") }},
			{"number", func() { delete(args, "number") }},
			{"rank", func() { delete(args, "rank") }},
		}
		for _, want := range order {
			_, err := w.try(w.owner.ID, "task.create", args)
			var ee *engine.Error
			if !errors.As(err, &ee) || ee.Field != want.field {
				t.Fatalf("want the refusal to name %q first, got %v (%+v)", want.field, err, ee)
			}
			want.fix()
		}
		w.do(w.owner.ID, "task.create", args)
	})
}

// TestATakenNumberAndAnIDInUseSayWhichTheyAre: two refusals with the code
// conflict give a reason a caller can act on without reading the message.
func TestATakenNumberAndAnIDInUseSayWhichTheyAre(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		made := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design", "number": 3}).Ref
		if e := w.refused(engine.CodeConflict, w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss art", "number": 3}); e.Reason != engine.ReasonNumberTaken {
			t.Fatalf("a number taken gives the reason %q, want %q", e.Reason, engine.ReasonNumberTaken)
		}
		if e := w.refused(engine.CodeConflict, w.owner.ID, "task.create", M{"id": made, "project": "SVA", "title": "Boss art"}); e.Reason != engine.ReasonInUse {
			t.Fatalf("an id in use gives the reason %q, want %q", e.Reason, engine.ReasonInUse)
		}
	})
}
