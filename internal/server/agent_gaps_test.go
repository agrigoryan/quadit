package server_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/cli"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// quadit runs the command-line tool against the site as the holder of
// token, and gives back what it printed and its exit code.
func (s *site) quadit(token string, args ...string) (string, int) {
	s.t.Helper()
	s.t.Setenv("QUADIT_URL", s.url)
	s.t.Setenv("QUADIT_TOKEN", token)
	s.t.Setenv("QUADIT_CONFIG", filepath.Join(s.dir, "no-config.json"))
	var out, errs bytes.Buffer
	code := cli.Run(args, &out, &errs)
	return out.String() + errs.String(), code
}

// agentToken makes an agent and a token for it.
func (s *site) agentToken(handle string) string {
	s.t.Helper()
	s.change(s.owner, "", "agent.create", M{"name": handle, "handle": handle})
	var tok struct {
		Token string `json:"token"`
	}
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@" + handle}, 201, &tok)
	return tok.Token
}

// someFiles writes small files to a folder and gives their paths by name.
func someFiles(t *testing.T, names ...string) map[string]string {
	dir := t.TempDir()
	out := map[string]string{}
	for _, n := range names {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("picture "+n), 0o600); err != nil {
			t.Fatal(err)
		}
		out[n] = p
	}
	return out
}

// askedFiles is what a task's events say was attached where: the file
// names on the question, and on each option by its id.
func (s *site) askedFiles(token, key string) (question []string, onOption map[string][]string) {
	s.t.Helper()
	var page struct {
		Events []struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		} `json:"events"`
	}
	s.call(nil, token, "GET", "/api/v1/w/-/events?task="+key+"&limit=500", nil, 200, &page)
	type att struct {
		SubjectType string `json:"subject_type"`
		SubjectID   string `json:"subject_id"`
		File        struct {
			Name string `json:"name"`
		} `json:"file"`
	}
	onOption = map[string][]string{}
	for _, ev := range page.Events {
		var d struct {
			Row         att   `json:"row"`
			Attachments []att `json:"attachments"`
		}
		json.Unmarshal(ev.Data, &d)
		switch ev.Type {
		case "decision.opened":
			for _, a := range d.Attachments {
				onOption[a.SubjectID] = append(onOption[a.SubjectID], a.File.Name)
			}
		case "attachment.created":
			if d.Row.SubjectType == "decision" {
				question = append(question, d.Row.File.Name)
			}
		}
	}
	return question, onOption
}

// TestAskWithFiles: a question goes out with its pictures in one go, each
// file on what it was typed after, and the same --id sent again does
// nothing twice.
func TestAskWithFiles(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		agent := s.agentToken("coder")
		f := someFiles(t, "context.png", "a.gif", "b.gif", "b-side.gif")

		// Nothing is sent when a file cannot be read.
		if out, code := s.quadit(agent, "ask", "SVA-1", "Which arrival?", "option=A", "file="+f["a.gif"], "option=B", "file=/no/such.gif"); code == 0 || !strings.Contains(out, "/no/such.gif") {
			t.Fatalf("an unreadable file: %d %s", code, out)
		}
		// A dry run uploads nothing and says where each file would go.
		ask := []string{"ask", "SVA-1", "Which arrival?", "file=" + f["context.png"], "option=A announced", "file=" + f["a.gif"],
			"option=B walks in", "file=" + f["b.gif"], "file=" + f["b-side.gif"], "recommended=2", "why=it surprises"}
		out, code := s.quadit(agent, append([]string{"--dry-run"}, ask...)...)
		if code != 0 || !strings.Contains(out, "would attach "+f["context.png"]+" to the question") || !strings.Contains(out, "would attach "+f["b-side.gif"]+" to option 2") {
			t.Fatalf("dry run: %d %s", code, out)
		}
		if detail := s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, nil); strings.Contains(detail, "Which arrival?") {
			t.Fatalf("the dry run opened the decision: %s", detail)
		}

		given := "--id=" + id.New()
		out, code = s.quadit(agent, append([]string{given, "--json"}, ask...)...)
		if code != 0 {
			t.Fatalf("ask with files: %d %s", code, out)
		}
		var res struct {
			Decision struct{ Ref string } `json:"decision"`
			Files    []struct{ ID, On string }
		}
		if err := json.Unmarshal([]byte(out), &res); err != nil || res.Decision.Ref == "" || len(res.Files) != 4 || res.Files[0].ID == "" {
			t.Fatalf("--json: %v %s", err, out)
		}

		var detail struct {
			Decisions []struct {
				ID          string
				Recommended int
				Options     []struct {
					ID          string
					Label       string
					Attachments []struct{ Name string }
				}
			}
		}
		s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &detail)
		if len(detail.Decisions) != 1 || len(detail.Decisions[0].Options) != 2 || detail.Decisions[0].Recommended != 2 {
			t.Fatalf("decisions = %+v", detail.Decisions)
		}
		names := func(i int) string {
			var n []string
			for _, a := range detail.Decisions[0].Options[i].Attachments {
				n = append(n, a.Name)
			}
			return strings.Join(n, ",")
		}
		if names(0) != "a.gif" || names(1) != "b.gif,b-side.gif" {
			t.Fatalf("option files = %q and %q", names(0), names(1))
		}
		// The question's own file came in the same write as the question.
		question, onOption := s.askedFiles(agent, "SVA-1")
		if strings.Join(question, ",") != "context.png" || strings.Join(onOption[detail.Decisions[0].Options[1].ID], ",") != "b.gif,b-side.gif" {
			t.Fatalf("question files %v, option files %v", question, onOption)
		}

		// The same command with the same id again: nothing new.
		var before struct{ Seq int64 }
		s.call(nil, agent, "GET", "/api/v1/w/-/me", nil, 200, &before)
		if out, code := s.quadit(agent, append([]string{given}, ask...)...); code != 0 {
			t.Fatalf("retry: %d %s", code, out)
		}
		var after struct{ Seq int64 }
		s.call(nil, agent, "GET", "/api/v1/w/-/me", nil, 200, &after)
		s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &detail)
		if after.Seq != before.Seq || len(detail.Decisions) != 1 || names(1) != "b.gif,b-side.gif" {
			t.Fatalf("the retry changed things: seq %d -> %d, %+v", before.Seq, after.Seq, detail.Decisions)
		}

		// An approval takes files too: they are on the question.
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Cut the intro"})
		if out, code := s.quadit(agent, "approval", "SVA-2", "Cut it?", "file="+f["a.gif"]); code != 0 {
			t.Fatalf("approval with a file: %d %s", code, out)
		}
		if question, _ := s.askedFiles(agent, "SVA-2"); strings.Join(question, ",") != "a.gif" {
			t.Fatalf("approval files = %v", question)
		}
	})
}

// TestUnassign: "none", "nobody", "-" and nothing at all clear the
// assignee, with assign and with update alike.
func TestUnassign(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		agent := s.agentToken("coder")
		assignee := func() any {
			var d struct{ Task struct{ Assignee any } }
			s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &d)
			return d.Task.Assignee
		}
		for _, cmd := range [][]string{{"assign", "SVA-1", "none"}, {"assign", "SVA-1", "nobody"}, {"assign", "SVA-1", "-"},
			{"assign", "SVA-1", ""}, {"update", "SVA-1", "assignee="}, {"update", "SVA-1", "assignee=none"}} {
			if out, code := s.quadit(agent, "assign", "SVA-1", "@aram"); code != 0 || assignee() != "@aram" {
				t.Fatalf("assign: %d %s", code, out)
			}
			if out, code := s.quadit(agent, cmd...); code != 0 {
				t.Fatalf("%q: %d %s", cmd, code, out)
			}
			if a := assignee(); a != nil && a != "" {
				t.Fatalf("%q left the task with %v", cmd, a)
			}
		}
	})
}
