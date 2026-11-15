package server_test

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
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
// is one call to ask, with files stored first by upload; so is a yes or no
// to an exact change.
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
		out, failed = mcpTool(t, s, token, "ask", M{"task": "SVA-2", "question": "Delete it?", "action": "task.delete", "files": []string{ctx}})
		if failed || !strings.HasPrefix(out, "ok decision.open SVA-2") {
			t.Fatalf("approval: %s", out)
		}
		text := s.call(nil, token, "GET", "/api/v1/w/-/tasks/SVA-2?format=text", nil, 200, nil)
		if !strings.Contains(text, "approval for: task.delete") || !strings.Contains(text, "file: context.png") {
			t.Fatalf("approval as read back:\n%s", text)
		}
	})
}

// TestQuietInBothForms: a change sent bare is read as one in a list is:
// quiet from an admin, refused from anyone else, in either form.
func TestQuietInBothForms(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		member := s.agentToken("coder")
		bare := func(body string) M {
			return M{"id": id.New(), "type": "comment.create", "args": M{"task": "SVA-1", "body": body}, "quiet": true}
		}
		forms := map[string]func(string) M{
			"bare":  bare,
			"batch": func(body string) M { return M{"changes": []M{bare(body)}} },
		}
		for name, form := range forms {
			s.call(nil, member, "POST", w+"/changes", form("psst from a member "+name), 403, nil)
			s.call(s.owner, "", "POST", w+"/changes", form("history "+name), 200, nil)
			var page struct {
				Events []struct{ Data map[string]any }
			}
			s.call(s.owner, "", "GET", w+"/events?task=SVA-1&types=comment.created&limit=500", nil, 200, &page)
			last := page.Events[len(page.Events)-1].Data
			if last["quiet"] != true {
				t.Fatalf("%s: an admin's quiet comment is not marked quiet: %v", name, last)
			}
		}
		if text := s.call(nil, member, "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil); strings.Contains(text, "psst") {
			t.Fatalf("a member's quiet change went in:\n%s", text)
		}
	})
}

// TestQuietHistorySetsNothingOff: tasks an admin brings in quietly start no
// rule and raise no watched-view alert, though they are in the feed and the
// search; webhooks, which mirror the feed, still get them, marked quiet. A
// change made afterwards sets all three off as before.
func TestQuietHistorySetsNothingOff(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "label.create", M{"name": "art", "project": "SVA"})
		coordinator := s.agentToken("coordinator")
		artist := s.agentToken("artist")
		s.change(s.owner, "", "rule.create", M{"name": "a new task to plan", "match": M{"event_types": []string{"task.created"}},
			"action": M{"kind": "notify", "user_id": "@coordinator"}})
		view := s.change(nil, artist, "view.create", M{"name": "Art", "query": M{"label": []string{"art"}}})
		s.change(nil, artist, "watch.set", M{"type": "view", "subject": view["ref"]})
		hook := newReceiver(t, "")
		s.change(s.owner, "", "webhook.create", M{"name": "mirror", "url": hook.srv.URL, "event_types": []string{"task.created"}})

		quiet := M{"changes": []M{{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Imported sprites", "labels": []string{"art"}}, "quiet": true}}}
		s.call(s.owner, "", "POST", w+"/changes", quiet, 200, nil)
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "New sprites", "labels": []string{"art"}})

		inbox := func(token string) string {
			return s.call(nil, token, "GET", "/api/v1/w/-/inbox?format=text&all=1", nil, 200, nil)
		}
		// The task made afterwards is news: rule, view alert and webhook.
		eventually(t, "the rule and the view alert for the new task", func() bool {
			return strings.Contains(inbox(coordinator), "SVA-2") && strings.Contains(inbox(artist), "SVA-2")
		})
		eventually(t, "the webhook to get both tasks", func() bool { return strings.Count(hook.types(), "task.created") == 2 })
		// Events are handled in order, so the imported one is done with by now.
		if a, b := inbox(coordinator), inbox(artist); strings.Contains(a, "SVA-1") || strings.Contains(b, "SVA-1") {
			t.Fatalf("the imported task set off a rule or a view alert:\ncoordinator: %s\nartist: %s", a, b)
		}
		hook.mu.Lock()
		first, second := hook.got[0], hook.got[1]
		hook.mu.Unlock()
		if first["quiet"] != true || second["quiet"] != nil {
			t.Fatalf("the webhook's quiet marks: imported %v, new %v", first["quiet"], second["quiet"])
		}
		// History is still in the search.
		if out := s.call(nil, artist, "GET", "/api/v1/w/-/search?q=Imported&format=text", nil, 200, nil); !strings.Contains(out, "SVA-1") {
			t.Fatalf("search: %s", out)
		}
	})
}
