package server_test

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// fileNames is the names of a list of files, joined with commas.
func fileNames(files []struct{ Name, URL string }) string {
	var n []string
	for _, f := range files {
		n = append(n, f.Name)
	}
	return strings.Join(n, ",")
}

// TestQuestionFilesShowWithTheDecision: files on the question itself come
// with the decision wherever its options' files do, in JSON and in text.
func TestQuestionFilesShowWithTheDecision(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		agent := s.agentToken("coder")
		f := someFiles(t, "context.png", "a.gif", "b.gif")
		if out, code := s.quadit(agent, "ask", "SVA-1", "Which arrival?", "file="+f["context.png"],
			"option=A", "file="+f["a.gif"], "option=B", "file="+f["b.gif"]); code != 0 {
			t.Fatalf("ask: %d %s", code, out)
		}

		type decision struct {
			Attachments []struct{ Name, URL string }
			Options     []struct {
				Attachments []struct{ Name, URL string }
			}
		}
		check := func(where string, ds []decision) {
			t.Helper()
			if len(ds) != 1 || len(ds[0].Options) != 2 {
				t.Fatalf("%s: decisions = %+v", where, ds)
			}
			d := ds[0]
			if fileNames(d.Attachments) != "context.png" || !strings.Contains(d.Attachments[0].URL, "/f/") {
				t.Fatalf("%s: question files = %+v", where, d.Attachments)
			}
			if fileNames(d.Options[0].Attachments) != "a.gif" || fileNames(d.Options[1].Attachments) != "b.gif" {
				t.Fatalf("%s: option files = %+v", where, d.Options)
			}
		}
		var detail struct{ Decisions []decision }
		s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &detail)
		check("task", detail.Decisions)
		var pack struct {
			Task struct{ Decisions []decision }
		}
		s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1/context", nil, 200, &pack)
		check("context pack", pack.Task.Decisions)

		// In text, the question's file is listed under the question with its address.
		for _, path := range []string{"/api/v1/w/-/tasks/SVA-1?format=text", "/api/v1/w/-/tasks/SVA-1/context?format=text"} {
			text := s.call(nil, agent, "GET", path, nil, 200, nil)
			q := strings.Index(text, "Which arrival?")
			file := strings.Index(text, "file: context.png "+s.url+"/f/")
			opt := strings.Index(text, "1) A")
			if q < 0 || file < q || opt < file {
				t.Fatalf("%s does not list the question's file between the question and the options:\n%s", path, text)
			}
		}
	})
}

// mcpTool calls one MCP tool through /mcp and gives back its text and
// whether it failed.
func mcpTool(t *testing.T, s *site, token, name string, args M) (string, bool) {
	t.Helper()
	body, _ := json.Marshal(M{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": M{"name": name, "arguments": args}})
	_, raw := mcpPost(t, s, token, string(body))
	var out struct {
		Result struct {
			Content []struct{ Text string }
			IsError bool
		}
		Error any
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil || out.Error != nil || len(out.Result.Content) == 0 {
		t.Fatalf("%s: %v %s", name, err, raw)
	}
	return out.Result.Content[0].Text, out.Result.IsError
}

// TestMCPAsk: over MCP, a question with files on its options and on itself
// is one call to ask, with files stored first by upload; an approval is
// one call too.
func TestMCPAsk(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		token := mcpAgentToken(s)
		fileID := regexp.MustCompile(`file id=(\S+)`)
		upload := func(name string) string {
			out, failed := mcpTool(t, s, token, "upload", M{"name": name, "text": "picture " + name})
			m := fileID.FindStringSubmatch(out)
			if failed || m == nil {
				t.Fatalf("upload %s: %s", name, out)
			}
			return m[1]
		}
		ctx, a, b := upload("context.png"), upload("a.gif"), upload("b.gif")

		_, list := mcpPost(t, s, token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
		if !strings.Contains(list, `"name":"ask"`) || !strings.Contains(list, "GET /api/v1/changes") {
			t.Fatalf("tools/list has no ask tool, or change does not say where the arguments are: %.300s", list)
		}

		ask := M{"task": "SVA-1", "question": "Which arrival?", "files": []string{ctx}, "recommended": 2, "why": "it surprises",
			"options": []M{{"label": "A", "description": "announced", "files": []string{a}}, {"label": "B", "files": []string{b}}}, "id": "01a1e04e-0000-7000-8000-000000000001"}
		out, failed := mcpTool(t, s, token, "ask", ask)
		if failed || !strings.HasPrefix(out, "ok decision.open SVA-1") || !strings.Contains(out, "file "+b+" on option 2") {
			t.Fatalf("ask: %s", out)
		}
		if again, failed := mcpTool(t, s, token, "ask", ask); failed {
			t.Fatalf("the same ask again: %s", again)
		}

		var detail struct {
			Decisions []struct {
				Kind, Recommendation string
				Recommended          int
				Attachments          []struct{ Name, URL string }
				Options              []struct {
					Label, Description string
					Attachments        []struct{ Name, URL string }
				}
			}
		}
		s.call(nil, token, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &detail)
		if len(detail.Decisions) != 1 {
			t.Fatalf("decisions = %+v", detail.Decisions)
		}
		d := detail.Decisions[0]
		if d.Kind != "choice" || d.Recommended != 2 || d.Recommendation != "it surprises" || len(d.Options) != 2 || d.Options[0].Description != "announced" {
			t.Fatalf("decision = %+v", d)
		}
		if fileNames(d.Attachments) != "context.png" || fileNames(d.Options[0].Attachments) != "a.gif" || fileNames(d.Options[1].Attachments) != "b.gif" {
			t.Fatalf("files: question %+v, options %+v", d.Attachments, d.Options)
		}

		// An approval of an exact change, with a file on the question.
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Cut the intro"})
		out, failed = mcpTool(t, s, token, "approval", M{"task": "SVA-2", "question": "Delete it?", "action": "task.delete", "files": []string{ctx}})
		if failed || !strings.HasPrefix(out, "ok decision.open SVA-2") {
			t.Fatalf("approval: %s", out)
		}
		text := s.call(nil, token, "GET", "/api/v1/w/-/tasks/SVA-2?format=text", nil, 200, nil)
		if !strings.Contains(text, "approval for: task.delete") || !strings.Contains(text, "file: context.png") {
			t.Fatalf("approval as read back:\n%s", text)
		}
	})
}
