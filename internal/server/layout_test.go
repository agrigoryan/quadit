package server_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestALayoutSaysTheEstimatesAProjectTakes: an agent reading a project's
// layout learns its scale and values, so it can send an estimate without
// being refused first, and what a 0 does there; a project that does not
// estimate says nothing of estimates.
func TestALayoutSaysTheEstimatesAProjectTakes(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		estimatedProjects(t, s)
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})

		s.change(t, s.owner, "", "project.create", M{"key": "ANY", "name": "Any number", "settings": M{"estimates": true, "estimate_scale": "points", "estimate_zero": true}})
		s.change(t, s.owner, "", "project.create", M{"key": "NOZ", "name": "No zero", "settings": M{"estimates": true, "estimate_scale": "points"}})
		for key, want := range map[string]string{
			"TEE": "estimates: 0, XS, S, M, L or XL (tshirt scale); 0 is an estimate of its own\n",
			"FIB": "estimates: 0, 1, 2, 3, 5 or 8 points (fibonacci scale); 0 is an estimate of its own\n",
			"ANY": "estimates: any whole number of points (points scale); 0 is an estimate of its own\n",
			"NOZ": "estimates: any whole number of points (points scale); 0 clears an estimate\n",
		} {
			if text := s.call(t, s.owner, "", "GET", w+"/projects/"+key+"/layout?format=text", nil, 200, nil); !strings.Contains(text, want) {
				t.Errorf("%s's layout, want %q:\n%s", key, want, text)
			}
		}
		if text := s.call(t, s.owner, "", "GET", w+"/projects/OPS/layout?format=text", nil, 200, nil); strings.Contains(text, "estimates") {
			t.Errorf("a project that does not estimate says:\n%s", text)
		}

		var layout struct {
			Project struct {
				Estimates map[string]any `json:"estimates"`
			} `json:"project"`
		}
		for key, want := range map[string]map[string]any{
			"TEE": {"scale": "tshirt", "values": []any{0.0, 1.0, 2.0, 3.0, 5.0, 8.0}, "sizes": []any{"XS", "S", "M", "L", "XL"},
				"words": "0, XS, S, M, L or XL", "zero": true},
			"ANY": {"scale": "points", "words": "any whole number of points", "zero": true},
			"NOZ": {"scale": "points", "words": "any whole number of points", "zero": false},
		} {
			layout.Project.Estimates = nil
			s.call(t, s.owner, "", "GET", w+"/projects/"+key+"/layout", nil, 200, &layout)
			if !reflect.DeepEqual(layout.Project.Estimates, want) {
				t.Errorf("%s's estimates are %v, want %v", key, layout.Project.Estimates, want)
			}
		}
	})
}
