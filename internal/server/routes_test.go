package server_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTheVersionSaysWhatTheServerIs: anyone may ask, without signing in,
// whether an address is a Quadit server, which version, which agent surface,
// which desktop sign-in hand-off it speaks and which version of the window
// without a title bar its web app lays itself out for; the desktop app asks
// before it adds a server.
func TestTheVersionSaysWhatTheServerIs(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	var v struct {
		Name    string
		Version string
		Surface string
		Desktop struct{ Handoff, Inset int }
	}
	s.call(t, nil, "", "GET", "/api/v1/version", nil, 200, &v)
	if v.Name != "quadit" || v.Version != "test" || v.Surface != engine.Surface || v.Desktop.Handoff != 1 || v.Desktop.Inset != 1 {
		t.Fatalf("version = %+v", v)
	}
}

// TestTheLicensesAreServed: /licenses gives Quadit's own license and the
// notices of the work of others it contains, to anyone.
func TestTheLicensesAreServed(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		text := s.call(t, nil, "", "GET", "/licenses", nil, 200, nil)
		for _, want := range []string{"MIT License", "THIRD-PARTY NOTICES FOR QUADIT", "github.com/jackc/pgx/v5", "@blocknote/core", "Mozilla Public License"} {
			if !strings.Contains(text, want) {
				t.Errorf("/licenses does not say %q", want)
			}
		}
	})
}

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
		s.call(t, nil, "", "GET", "/api/v1/changes", nil, 200, &cat)
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
		text := s.call(t, nil, "", "GET", "/api/v1/changes?format=text", nil, 200, nil)
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
		s.call(t, nil, "", "GET", "/api/v1/openapi.json", nil, 200, &spec)
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
	s.call(t, nil, "", "GET", "/api/v1/openapi.json", nil, 200, &spec)
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
	s.change(t, s.owner, "", "label.create", M{"name": "kept"})
	gone := s.change(t, s.owner, "", "label.create", M{"name": "gone"})["ref"].(string)
	s.change(t, s.owner, "", "label.delete", M{"id": gone})
	var out struct{ Labels []struct{ Name string } }
	s.call(t, s.owner, "", "GET", w+"/list/labels?trash=1", nil, 200, &out)
	var names []string
	for _, l := range out.Labels {
		names = append(names, l.Name)
	}
	if !slices.Equal(names, []string{"gone"}) {
		t.Fatalf("the labels' trash lists %v, want only the deleted one", names)
	}
}

// TestRelationsOfATaskAreListedFromEitherEnd: /list/relations?task= lists
// every relation the task is at an end of, whether it was made from the
// task or from the other one. Asked by a task the caller may not read, it
// is not found: the list would say which task the blank end is.
func TestRelationsOfATaskAreListedFromEitherEnd(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		for _, title := range []string{"Boss design", "Boss music", "Boss art"} {
			s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": title})
		}
		blocks := s.change(t, s.owner, "", "relation.add", M{"task": "SVA-1", "type": "blocks", "other": "SVA-2"})["ref"].(string)
		relates := s.change(t, s.owner, "", "relation.add", M{"task": "SVA-2", "type": "relates", "other": "SVA-3"})["ref"].(string)
		for task, want := range map[string][]string{"SVA-1": {blocks}, "SVA-2": {blocks, relates}, "SVA-3": {relates}} {
			var out struct{ Relations []struct{ ID string } }
			s.call(t, s.owner, "", "GET", w+"/list/relations?task="+task, nil, 200, &out)
			var got []string
			for _, r := range out.Relations {
				got = append(got, r.ID)
			}
			if !slices.Equal(got, want) {
				t.Errorf("the relations of %s are %v, want %v", task, got, want)
			}
		}

		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
		s.change(t, s.owner, "", "relation.add", M{"task": "OPS-1", "type": "blocks", "other": "SVA-1"})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "SVA only", "projects": []string{"SVA"}}, 201, &tok)
		s.call(t, nil, tok.Token, "GET", w+"/list/relations?task=OPS-1", nil, 404, nil)
	})
}
