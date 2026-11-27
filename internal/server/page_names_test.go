package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTheTextAnAgentReadsNamesThePagesItPointsAt: in the text an agent
// reads (a task, its context pack, the feed, the inbox) a page named by its
// id is followed by the page's title as it is now. A link that carries the
// title already stays as written, and gains the new title once the page is
// renamed; [[Title]] stays as written. A page the reader may not see, and
// one in the trash, stay as written, with no title.
func TestTheTextAnAgentReadsNamesThePagesItPointsAt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		review := s.change(t, s.owner, "", "doc.create", M{"title": "Meta rework review", "markdown": "what we found\n"})["ref"].(string)
		runbook := s.change(t, s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "rotate\n"})["ref"].(string)
		old := s.change(t, s.owner, "", "doc.create", M{"title": "Old plan", "markdown": "first try\n"})["ref"].(string)
		s.change(t, s.owner, "", "doc.delete", M{"id": old})
		address := s.url + "/games/docs/" + review
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "The page is doc:" + review +
			", also [Meta rework review](doc:" + review + ") and [the notes](doc:" + review + ") and [[Meta rework review]]" +
			"; see " + address + ", doc:" + runbook + " and doc:" + old + "."})
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "@narrow read doc:" + review + " and doc:" + runbook})

		named := `doc:` + review + ` ("Meta rework review")`
		show := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil)
		for _, want := range []string{
			named,
			"[Meta rework review](doc:" + review + ") and",
			"[the notes](doc:" + review + `) ("Meta rework review")`,
			"[[Meta rework review]];",
			address + ` ("Meta rework review")`,
			"doc:" + runbook + ` ("Vault runbook")`,
			"doc:" + old + ".",
		} {
			if !strings.Contains(show, want) {
				t.Errorf("the task as text does not say %s: %s", want, show)
			}
		}

		reads := map[string]string{
			"the task":         s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil),
			"the context pack": s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1/context?format=text", nil, 200, nil),
			"the feed":         s.call(t, nil, narrow, "GET", w+"/events?task=SVA-1&format=text", nil, 200, nil),
			"the inbox":        s.call(t, nil, narrow, "GET", w+"/inbox?format=text", nil, 200, nil),
		}
		for read, out := range reads {
			if !strings.Contains(out, named) {
				t.Errorf("%s does not name the page a reader of SVA may see: %s", read, out)
			}
			if !strings.Contains(out, "doc:"+runbook) || strings.Contains(out, "Vault runbook") {
				t.Errorf("%s names a page of OPS to a reader of SVA, or leaves its reference out: %s", read, out)
			}
		}

		s.change(t, s.owner, "", "doc.update", M{"id": review, "title": "Meta rework, final"})
		show = s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil)
		for _, want := range []string{
			`doc:` + review + ` ("Meta rework, final")`,
			"[Meta rework review](doc:" + review + `) ("Meta rework, final")`,
			"[[Meta rework review]];",
		} {
			if !strings.Contains(show, want) {
				t.Errorf("after the page was renamed, the task as text does not say %s: %s", want, show)
			}
		}
	})
}
