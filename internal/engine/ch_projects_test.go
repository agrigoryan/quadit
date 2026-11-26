package engine_test

import (
	"context"
	"maps"
	"slices"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTheServerNamesTheScaleOfAProjectThatEstimates: turning estimates on
// without a scale starts on Fibonacci, at creation too; a project that
// estimated before scales (none named) keeps any whole number, now named;
// a scale named is kept; one unknown is refused with the names.
func TestTheServerNamesTheScaleOfAProjectThatEstimates(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		settings := func(projectID string) core.ProjectSettings {
			t.Helper()
			if s := w.project(projectID).Settings; s != nil {
				return *s
			}
			return core.ProjectSettings{}
		}

		made := w.do(w.owner.ID, "project.create", M{"key": "NEW", "name": "Made estimating", "settings": M{"estimates": true}}).Ref
		if got := settings(made).EstimateScale; got != core.ScaleFibonacci {
			t.Errorf("a project made estimating is on %q", got)
		}

		turned := w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
		w.do(w.owner.ID, "project.update", M{"id": "SVA", "settings": M{"cycles": true}})
		if got := settings(turned).EstimateScale; got != "" {
			t.Errorf("a project that does not estimate was given the scale %q", got)
		}
		w.do(w.owner.ID, "project.update", M{"id": "SVA", "settings": M{"estimates": true}})
		if got := settings(turned).EstimateScale; got != core.ScaleFibonacci {
			t.Errorf("turning estimates on starts on %q", got)
		}

		// A project that estimated before there were scales.
		older := w.do(w.owner.ID, "project.create", M{"key": "OLD", "name": "Older"}).Ref
		if _, err := w.db().Update(context.Background(), "projects", map[string]any{"settings": `{"estimates":true}`}, store.Eq("id", older)); err != nil {
			t.Fatal(err)
		}
		w.do(w.owner.ID, "project.update", M{"id": "OLD", "settings": M{"estimates": true, "cycles": true}})
		if got := settings(older).EstimateScale; got != core.ScalePoints {
			t.Errorf("a project that estimated before scales is now on %q", got)
		}

		w.do(w.owner.ID, "project.update", M{"id": "OLD", "settings": M{"estimates": true, "estimate_scale": "TShirt"}})
		if got := settings(older).EstimateScale; got != core.ScaleTShirt {
			t.Errorf("a scale named is stored as %q", got)
		}
		e := w.refused(engine.CodeInvalid, w.owner.ID, "project.update", M{"id": "OLD", "settings": M{"estimates": true, "estimate_scale": "fibonaci"}})
		if e.Field != "settings" || !slices.Equal(e.Allowed, core.EstimateScales) || e.Nearest != core.ScaleFibonacci {
			t.Errorf("an unknown scale: %+v", e)
		}
	})
}

// TestEstimateOptionsAreKeptWhileEstimatesAreOff: turning estimates off
// keeps the scale and its options as sent, and turning them on again with
// them brings them back.
func TestEstimateOptionsAreKeptWhileEstimatesAreOff(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		options := M{"estimate_scale": "linear", "estimate_extended": true, "estimate_zero": true, "estimate_ignore_unestimated": true}
		with := func(estimates bool) M {
			s := M{"estimates": estimates}
			maps.Copy(s, options)
			return s
		}
		pid := w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien", "settings": with(true)}).Ref
		w.do(w.owner.ID, "project.update", M{"id": "SVA", "settings": with(false)})
		want := core.ProjectSettings{EstimateScale: core.ScaleLinear, EstimateExtended: true, EstimateZero: true, EstimateIgnoreUnestimated: true}
		if got := *w.project(pid).Settings; got != want {
			t.Fatalf("estimates off keep %+v, want %+v", got, want)
		}
		w.do(w.owner.ID, "project.update", M{"id": "SVA", "settings": with(true)})
		want.Estimates = true
		if got := *w.project(pid).Settings; got != want {
			t.Fatalf("estimates on again have %+v, want %+v", got, want)
		}
	})
}
