package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestDryRunWritesNothingOnAnyPath: a dry run, asked of the command-line
// tool or of an MCP tool, never writes; a write that cannot be checked
// without being made is refused rather than made; and an MCP argument of
// the wrong type is refused rather than dropped.
func TestDryRunWritesNothingOnAnyPath(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion effect"})
		agent := s.agentToken("dry")
		feed := func() int64 {
			var page struct{ Seq int64 }
			s.call(s.owner, "", "GET", w+"/events?limit=2000", nil, 200, &page)
			return page.Seq
		}
		memory := func() string { return s.call(nil, agent, "GET", "/api/v1/w/-/memory?format=text", nil, 200, nil) }
		cursor := func(name string) int64 {
			var c struct{ Seq int64 }
			s.call(nil, agent, "GET", "/api/v1/w/-/cursors/"+name, nil, 200, &c)
			return c.Seq
		}
		files := func() int {
			n, err := st.Count(context.Background(), "files")
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
		note := filepath.Join(t.TempDir(), "note.md")
		if err := os.WriteFile(note, []byte("- rings read badly small\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		picture := someFiles(t, "burst.png")["burst.png"]

		t.Run("the command-line tool", func(t *testing.T) {
			before, filesBefore := feed(), files()
			f, err := os.Open(note)
			if err != nil {
				t.Fatal(err)
			}
			was := os.Stdin
			os.Stdin = f
			out, code := s.quadit(agent, "--dry-run", "remember", "Preferences")
			os.Stdin = was
			f.Close()
			if code != 0 || !strings.Contains(out, "would be accepted") {
				t.Fatalf("a dry remember: %d %s", code, out)
			}
			if out, code := s.quadit(agent, "--dry-run", "ack", "2", "main"); code != 0 || !strings.Contains(out, "would be accepted") {
				t.Fatalf("a dry ack: %d %s", code, out)
			}
			if out, code := s.quadit(agent, "--dry-run", "ack", "99999", "main"); code == 0 {
				t.Fatalf("a dry ack past the end of the feed was accepted: %s", out)
			}
			for _, args := range [][]string{{"upload", picture}, {"attach", "SVA-1", picture}, {"comment", "SVA-1", "file=" + picture, "Looks right"}} {
				if out, code := s.quadit(agent, append([]string{"--dry-run"}, args...)...); code != 0 || !strings.Contains(out, "would") {
					t.Fatalf("a dry %s: %d %s", args[0], code, out)
				}
			}
			for _, args := range [][]string{{"request", "KEY", "https://example.com"}, {"run", "--secret", "KEY", "--", "true"}, {"listen", "--exec", "true"}} {
				if out, code := s.quadit(agent, append([]string{"--dry-run"}, args...)...); code == 0 || !strings.Contains(out, "no dry run") {
					t.Fatalf("a dry %s was not refused: %d %s", args[0], code, out)
				}
			}
			if strings.Contains(memory(), "rings") || cursor("main") != 0 || feed() != before || files() != filesBefore {
				t.Fatalf("a dry run wrote: memory %q, cursor %d, feed %d -> %d, files %d -> %d", memory(), cursor("main"), before, feed(), filesBefore, files())
			}
		})

		t.Run("MCP", func(t *testing.T) {
			before := feed()
			var list struct {
				Result struct {
					Tools []struct {
						Name        string
						InputSchema struct {
							Properties map[string]struct {
								Type any `json:"type"`
							}
						}
					}
				}
			}
			_, raw := mcpPost(t, s, agent, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			if err := json.Unmarshal([]byte(raw), &list); err != nil {
				t.Fatal(err)
			}
			typeOf := map[string]string{}
			for _, tool := range list.Result.Tools {
				for name, p := range tool.InputSchema.Properties {
					raw, _ := json.Marshal(p.Type)
					typeOf[tool.Name+"."+name] = string(raw)
				}
			}
			for arg, want := range map[string]string{"change.dry_run": `"boolean"`, "ask.dry_run": `"boolean"`, "remember.dry_run": `"boolean"`, "ack.dry_run": `"boolean"`,
				"tasks.open": `"boolean"`, "tasks.count": `"boolean"`, "tasks.limit": `"integer"`, "events.wait": `"integer"`, "ack.seq": `"integer"`, "task.since": `"integer"`,
				"task.key": `"string"`, "change.args": `"object"`, "upload.size": `"integer"`} {
				if typeOf[arg] != want {
					t.Errorf("%s is described as %s, want %s", arg, typeOf[arg], want)
				}
			}

			// A flag sent as text, a number sent as text: refused, and
			// nothing is written.
			for _, c := range []struct {
				tool string
				args M
			}{
				{"change", M{"type": "task.update", "args": M{"id": "SVA-1", "title": "Changed for real"}, "dry_run": "true"}},
				{"ask", M{"task": "SVA-1", "question": "Ring or burst?", "dry_run": "yes"}},
				{"ack", M{"seq": "2", "cursor": "mcp"}},
				{"remember", M{"title": "Preferences", "markdown": "rings", "dry_run": 1}},
				{"upload", M{"name": "a.txt", "text": "hello", "dry_run": true}},
			} {
				if out, failed := mcpTool(t, s, agent, c.tool, c.args); !failed {
					t.Errorf("%s %v was not refused: %s", c.tool, c.args, out)
				}
			}
			for _, c := range []struct {
				tool string
				args M
			}{
				{"change", M{"type": "task.update", "args": M{"id": "SVA-1", "title": "Changed for real"}, "dry_run": true}},
				{"remember", M{"title": "Preferences", "markdown": "rings", "dry_run": true}},
				{"ack", M{"seq": 2, "cursor": "mcp", "dry_run": true}},
			} {
				if out, failed := mcpTool(t, s, agent, c.tool, c.args); failed || !strings.Contains(out, "would be accepted") {
					t.Errorf("a dry %s: %v %s", c.tool, failed, out)
				}
			}
			if strings.Contains(memory(), "rings") || cursor("mcp") != 0 || feed() != before {
				t.Fatalf("a dry run over MCP wrote: memory %q, cursor %d, feed %d -> %d", memory(), cursor("mcp"), before, feed())
			}
			// The same calls, not dry, do write.
			if out, failed := mcpTool(t, s, agent, "ack", M{"seq": 2, "cursor": "mcp"}); failed || cursor("mcp") != 2 {
				t.Fatalf("ack over MCP: %v %s", failed, out)
			}
		})
	})
}
