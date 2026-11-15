package server_test

import (
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
