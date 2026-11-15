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
