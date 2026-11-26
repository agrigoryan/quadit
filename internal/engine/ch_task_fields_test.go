package engine_test

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// estimateOf is a task's estimate as the test says it: "none" or the number.
func (w *world) estimateOf(ref string) string {
	w.t.Helper()
	if e := w.task(ref).Estimate; e != nil {
		b, _ := json.Marshal(*e)
		return string(b)
	}
	return "none"
}

// TestAnEstimateIsHeldToTheProjectsScale: on a scale, an estimate named in
// a change is one of its values (with the extended ones when it is
// extended), and a refusal says them in the project's words; a T-shirt
// size stands for its number.
func TestAnEstimateIsHeldToTheProjectsScale(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien", "settings": M{"estimates": true}})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations", "settings": M{"estimates": true, "estimate_scale": "tshirt"}})

		e := w.refused(engine.CodeInvalid, w.owner.ID, "task.create", M{"project": "SVA", "title": "Jump", "estimate": 4})
		if e.Field != "estimate" || e.Message != "this project estimates in 1, 2, 3, 5 or 8 points" {
			t.Fatalf("an estimate off the Fibonacci scale: %+v", e)
		}
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Jump", "estimate": 5})
		w.refused(engine.CodeInvalid, w.owner.ID, "task.update", M{"id": "SVA-1", "estimate": 13})
		w.do(w.owner.ID, "project.update", M{"id": "SVA", "settings": M{"estimates": true, "estimate_scale": "fibonacci", "estimate_extended": true}})
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "estimate": 13})
		if got := w.estimateOf("SVA-1"); got != "13" {
			t.Fatalf("an extended value: %s", got)
		}

		e = w.refused(engine.CodeInvalid, w.owner.ID, "task.create", M{"project": "OPS", "title": "Rotate keys", "estimate": 4})
		if e.Message != "this project estimates in XS, S, M, L or XL" || !slices.Equal(e.Allowed, []string{"XS", "S", "M", "L", "XL"}) {
			t.Fatalf("an estimate off the T-shirt scale: %+v", e)
		}
		w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Rotate keys", "estimate": "m"})
		if got := w.estimateOf("OPS-1"); got != "3" {
			t.Fatalf("a T-shirt size is stored as %s, want its number", got)
		}
		w.do(w.owner.ID, "task.update", M{"id": "OPS-1", "estimate": 8})
		if got := w.estimateOf("OPS-1"); got != "8" {
			t.Fatalf("a number on the T-shirt scale: %s", got)
		}
	})
}

// TestATShirtSizeStandsForItsNumberOnEveryProject: a size is taken on any
// project, even one that estimates in any whole number; a word that is not
// a size is refused with the sizes.
func TestATShirtSizeStandsForItsNumberOnEveryProject(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Jump", "estimate": "XL"})
		if got := w.estimateOf("SVA-1"); got != "8" {
			t.Fatalf("XL is %s, want 8", got)
		}
		e := w.refused(engine.CodeInvalid, w.owner.ID, "task.update", M{"id": "SVA-1", "estimate": "huge"})
		if e.Field != "estimate" || !slices.Equal(e.Allowed, core.TShirtSizes) {
			t.Fatalf("a word that is not a size: %+v", e)
		}
		// A number written as text is digits only, as the web app reads it.
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "estimate": "5"})
		if got := w.estimateOf("SVA-1"); got != "5" {
			t.Fatalf("\"5\" is %s, want 5", got)
		}
		for _, signed := range []string{"+3", "-0"} {
			w.refused(engine.CodeInvalid, w.owner.ID, "task.update", M{"id": "SVA-1", "estimate": signed})
		}
	})
}

// TestZeroIsAnEstimateOnlyWhereTheProjectAllowsIt: where zero estimates are
// allowed, 0 is an estimate apart from none; elsewhere a 0 clears, as it
// always did. Null clears everywhere. The feed says none as null.
func TestZeroIsAnEstimateOnlyWhereTheProjectAllowsIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "OFF", "name": "Not estimating"})
		w.do(w.owner.ID, "project.create", M{"key": "FIB", "name": "Fibonacci", "settings": M{"estimates": true}})
		w.do(w.owner.ID, "project.create", M{"key": "ZERO", "name": "With zero", "settings": M{"estimates": true, "estimate_zero": true}})
		for _, key := range []string{"OFF", "FIB"} {
			w.do(w.owner.ID, "task.create", M{"project": key, "title": "Jump", "estimate": 0})
			if got := w.estimateOf(key + "-1"); got != "none" {
				t.Errorf("%s: a 0 is stored as %s, want none", key, got)
			}
			w.do(w.owner.ID, "task.update", M{"id": key + "-1", "estimate": 3})
			w.do(w.owner.ID, "task.update", M{"id": key + "-1", "estimate": 0})
			if got := w.estimateOf(key + "-1"); got != "none" {
				t.Errorf("%s: a 0 leaves %s, want none", key, got)
			}
		}

		w.do(w.owner.ID, "task.create", M{"project": "ZERO", "title": "Jump", "estimate": 0})
		if got := w.estimateOf("ZERO-1"); got != "0" {
			t.Fatalf("a zero estimate is stored as %s", got)
		}
		w.do(w.owner.ID, "task.update", M{"id": "ZERO-1", "estimate": nil})
		if got := w.estimateOf("ZERO-1"); got != "none" {
			t.Fatalf("null leaves %s", got)
		}
		w.do(w.owner.ID, "task.update", M{"id": "ZERO-1", "estimate": 0})
		if got := w.estimateOf("ZERO-1"); got != "0" {
			t.Fatalf("a zero estimate is set as %s", got)
		}

		var events []core.Event
		if err := w.db().List(context.Background(), &events, store.Q{Where: []store.Cond{store.Eq("type", "task.updated"), store.Eq("entity_id", w.task("ZERO-1").ID)}, Order: "seq"}); err != nil {
			t.Fatal(err)
		}
		// Read, not compared as text: Postgres keeps an event's JSON with its keys in an order of its own.
		said := func(n *int) string {
			if n == nil {
				return "none"
			}
			return strconv.Itoa(*n)
		}
		var changes []string
		for _, ev := range events {
			var data struct {
				Changes map[string]struct{ From, To *int } `json:"changes"`
			}
			if err := json.Unmarshal(ev.Data, &data); err != nil {
				t.Fatal(err)
			}
			change := data.Changes["estimate"]
			changes = append(changes, said(change.From)+" to "+said(change.To))
		}
		if want := []string{"0 to none", "none to 0"}; !slices.Equal(changes, want) {
			t.Fatalf("the feed says %v, want %v", changes, want)
		}
	})
}

// TestOnlyAnEstimateNamedInAChangeIsChecked: estimates already stored stay
// when the scale changes, a template's is applied as it is, and one kept as
// given (an import's) is taken off the scale, 0 included.
func TestOnlyAnEstimateNamedInAChangeIsChecked(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Jump", "estimate": 4})
		w.do(w.owner.ID, "project.update", M{"id": "SVA", "settings": M{"estimates": true, "estimate_scale": "fibonacci"}})
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "title": "Jump higher"})
		if got := w.estimateOf("SVA-1"); got != "4" {
			t.Fatalf("a stored estimate off the new scale became %s", got)
		}

		w.do(w.owner.ID, "template.create", M{"name": "Big", "project": "SVA", "preset": M{"estimate": 4}})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss", "template": "Big"})
		if got := w.estimateOf("SVA-2"); got != "4" {
			t.Fatalf("a template's estimate became %s", got)
		}
		w.refused(engine.CodeInvalid, w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss", "template": "Big", "estimate": 4})

		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Imported", "estimate": 4, "keep_estimate": true})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Imported at zero", "estimate": 0, "keep_estimate": true})
		if got := w.estimateOf("SVA-3") + " " + w.estimateOf("SVA-4"); got != "4 0" {
			t.Fatalf("estimates kept as given became %s", got)
		}
		w.refused(engine.CodeInvalid, w.owner.ID, "task.create", M{"project": "SVA", "title": "Imported", "estimate": -1, "keep_estimate": true})
	})
}
