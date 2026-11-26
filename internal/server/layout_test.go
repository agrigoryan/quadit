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
// being refused first; a project that does not estimate says nothing of
// estimates.
func TestALayoutSaysTheEstimatesAProjectTakes(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		estimatedProjects(t, s)
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})

		for key, want := range map[string]string{
			"TEE": "estimates: 0, XS, S, M, L or XL (tshirt scale)\n",
			"FIB": "estimates: 0, 1, 2, 3, 5 or 8 points (fibonacci scale)\n",
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
		s.call(t, s.owner, "", "GET", w+"/projects/TEE/layout", nil, 200, &layout)
		want := map[string]any{"scale": "tshirt", "values": []any{0.0, 1.0, 2.0, 3.0, 5.0, 8.0}, "sizes": []any{"XS", "S", "M", "L", "XL"},
			"words": "0, XS, S, M, L or XL"}
		if !reflect.DeepEqual(layout.Project.Estimates, want) {
			t.Errorf("TEE's estimates are %v, want %v", layout.Project.Estimates, want)
		}
	})
}
