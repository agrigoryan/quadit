package mcp

import (
	"strings"
	"testing"
)

func TestCheckArgsHoldsACallToTheSchemaItAdvertises(t *testing.T) {
	tool := tool{Name: "example", Props: map[string]arg{
		"!task":   text("task key"),
		"limit":   integer(""),
		"options": optionList(""),
		"changes": changeList(""),
		"ids":     textList(""),
		"headers": headers(""),
	}}
	for _, c := range []struct {
		name string
		args map[string]any
		want string // what the refusal says; "" for none
	}{
		{"what it takes", map[string]any{"task": "SVA-1", "limit": 5.0}, ""},
		{"a required argument missing", map[string]any{"limit": 5.0}, "task is missing"},
		{"a required argument null", map[string]any{"task": nil}, "task is missing"},
		{"a whole number with a fraction", map[string]any{"task": "SVA-1", "limit": 5.5}, "limit must be a whole number"},
		{"a list of objects, each with what it needs", map[string]any{"task": "SVA-1", "options": []any{
			map[string]any{"label": "Ring", "files": []any{"f1"}}, map[string]any{"label": "Burst", "description": "bigger"},
		}}, ""},
		{"an item of a list without a required field", map[string]any{"task": "SVA-1", "options": []any{
			map[string]any{"label": "Ring"}, map[string]any{"description": "no label"},
		}}, "options[1].label is missing"},
		{"a field of an item of the wrong type", map[string]any{"task": "SVA-1", "options": []any{
			map[string]any{"label": 7.0},
		}}, "options[0].label must be text"},
		{"a list inside an item, of the wrong type", map[string]any{"task": "SVA-1", "options": []any{
			map[string]any{"label": "Ring", "files": []any{"f1", 2.0}},
		}}, "options[0].files[1] must be text"},
		{"an item that is not an object", map[string]any{"task": "SVA-1", "changes": []any{"task.update"}}, "changes[0] must be an object"},
		{"an object inside an item, of the wrong type", map[string]any{"task": "SVA-1", "changes": []any{
			map[string]any{"type": "task.update", "args": "not an object"},
		}}, "changes[0].args must be an object"},
		{"a list as its JSON text, checked the same", map[string]any{"task": "SVA-1", "changes": `[{"args": {}}]`}, "changes[0].type is missing"},
		{"a list as its JSON text", map[string]any{"task": "SVA-1", "changes": `[{"type": "task.update", "args": {"id": "SVA-1"}}]`}, ""},
		{"ids written with commas", map[string]any{"task": "SVA-1", "ids": "f1,f2"}, ""},
		{"an object as its JSON text, or any text", map[string]any{"task": "SVA-1", "headers": `{"Accept": "text/plain"}`}, ""},
		{"a dry run where there is none", map[string]any{"task": "SVA-1", "dry_run": true}, "example has no dry run"},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := checkArgs(tool, c.args)
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("refused: %v", err)
			case c.want != "" && err == nil:
				t.Fatalf("let through; want %q", c.want)
			case c.want != "" && !strings.Contains(err.Error(), c.want):
				t.Fatalf("refused with %q; want %q", err, c.want)
			}
		})
	}
}
