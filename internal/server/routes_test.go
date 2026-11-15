package server_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestChangeCatalogSaysWhatIsRequired: the list of change types, as JSON,
// as text (what the command-line tool and the MCP changes tool show) and in
// the OpenAPI document, marks the arguments a change is refused without.
func TestChangeCatalogSaysWhatIsRequired(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	t.Run("json", func(t *testing.T) {
		var cat struct {
			Changes []struct {
				Type string
				Args []struct {
					Name     string
					Required bool
				}
			}
		}
		s.call(nil, "", "GET", "/api/v1/changes", nil, 200, &cat)
		required := map[string]bool{}
		for _, ci := range cat.Changes {
			if ci.Type == "task.move" {
				for _, a := range ci.Args {
					required[a.Name] = a.Required
				}
			}
		}
		if !required["id"] || !required["project"] {
			t.Fatalf("task.move's arguments, required or not: %v", required)
		}
	})
	t.Run("text", func(t *testing.T) {
		text := s.call(nil, "", "GET", "/api/v1/changes?format=text", nil, 200, nil)
		for _, want := range []string{"task.move (member): id (required), project (required)\n", "doc.write (member): doc (required), markdown, mode\n"} {
			if !strings.Contains(text, want) {
				t.Fatalf("no line %q in:\n%s", want, text)
			}
		}
	})
	t.Run("openapi", func(t *testing.T) {
		var spec struct {
			Components struct {
				Schemas struct {
					Change struct {
						OneOf []struct {
							Title      string
							Properties struct {
								Args struct{ Required []string }
							}
						}
					}
				}
			}
		}
		s.call(nil, "", "GET", "/api/v1/openapi.json", nil, 200, &spec)
		for _, ch := range spec.Components.Schemas.Change.OneOf {
			if ch.Title != "task.move" {
				continue
			}
			if got := ch.Properties.Args.Required; !slices.Equal(got, []string{"id", "project"}) {
				t.Fatalf("task.move requires %v", got)
			}
			return
		}
		t.Fatal("no task.move in the OpenAPI document")
	})
}

// TestEveryRouteIsDescribed checks the words of openapi.json, which is made
// from the same list of routes as the mux: every operation says what it
// does and is in a group, and every part of an address that is filled in
// says what goes there. (Two routes with one pattern fail every test: the
// mux panics when the server is made.)
func TestEveryRouteIsDescribed(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	var spec struct {
		Paths map[string]map[string]struct {
			Summary    string
			Tags       []string
			Parameters []struct{ Name, In, Description string }
		}
	}
	s.call(nil, "", "GET", "/api/v1/openapi.json", nil, 200, &spec)
	n := 0
	for path, methods := range spec.Paths {
		for method, op := range methods {
			n++
			if op.Summary == "" || len(op.Tags) != 1 || op.Tags[0] == "" {
				t.Errorf("%s %s: no summary, or no group (%q, %q)", strings.ToUpper(method), path, op.Summary, op.Tags)
			}
			for _, p := range op.Parameters {
				if p.In == "path" && p.Description == "" {
					t.Errorf("%s %s: the path parameter {%s} has no description", strings.ToUpper(method), path, p.Name)
				}
			}
		}
	}
	if n < 100 {
		t.Fatalf("openapi.json describes only %d operations", n)
	}
}

// TestAListsTrashIsTheDeletedRowsAlone: /list/{kind}?trash=1 lists the rows
// in the trash instead of the live ones, as the page and file trash do.
func TestAListsTrashIsTheDeletedRowsAlone(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(s.owner, "", "label.create", M{"name": "kept"})
	gone := s.change(s.owner, "", "label.create", M{"name": "gone"})["ref"].(string)
	s.change(s.owner, "", "label.delete", M{"id": gone})
	var out struct{ Labels []struct{ Name string } }
	s.call(s.owner, "", "GET", w+"/list/labels?trash=1", nil, 200, &out)
	var names []string
	for _, l := range out.Labels {
		names = append(names, l.Name)
	}
	if !slices.Equal(names, []string{"gone"}) {
		t.Fatalf("the labels' trash lists %v, want only the deleted one", names)
	}
}
