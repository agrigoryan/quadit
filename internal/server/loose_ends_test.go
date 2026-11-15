package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestDecisionLogHasTheFiles: the decision log carries the files on each
// question and on each of its options, as the task does, in JSON and text.
func TestDecisionLogHasTheFiles(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss exit"})
		agent := s.agentToken("coder")
		f := someFiles(t, "context.png", "a.gif", "b.gif", "exit.png")
		if out, code := s.quadit(agent, "ask", "SVA-1", "Which arrival?", "file="+f["context.png"],
			"option=A", "file="+f["a.gif"], "option=B", "file="+f["b.gif"]); code != 0 {
			t.Fatalf("ask: %d %s", code, out)
		}
		if out, code := s.quadit(agent, "ask", "SVA-2", "Which exit?", "option=Left", "file="+f["exit.png"], "option=Right"); code != 0 {
			t.Fatalf("ask: %d %s", code, out)
		}

		var log struct {
			Decisions []struct {
				Question    string
				Attachments []struct{ Name, URL string }
				Options     []struct {
					Attachments []struct{ Name, URL string }
				}
			}
		}
		s.call(nil, agent, "GET", "/api/v1/w/-/decisions?state=all", nil, 200, &log)
		got := map[string]string{}
		for _, d := range log.Decisions {
			files := []string{fileNames(d.Attachments)}
			for _, o := range d.Options {
				files = append(files, fileNames(o.Attachments))
			}
			got[d.Question] = strings.Join(files, "|")
		}
		if got["Which arrival?"] != "context.png|a.gif|b.gif" || got["Which exit?"] != "|exit.png|" {
			t.Fatalf("files in the log (question|option 1|option 2): %q", got)
		}

		text := s.call(nil, agent, "GET", "/api/v1/w/-/decisions?state=all&format=text", nil, 200, nil)
		for _, want := range []string{"file: context.png " + s.url + "/f/", "option 1 file: a.gif " + s.url + "/f/",
			"option 2 file: b.gif ", "option 1 file: exit.png "} {
			if !strings.Contains(text, want) {
				t.Errorf("the log in text has no %q:\n%s", want, text)
			}
		}
	})
}
