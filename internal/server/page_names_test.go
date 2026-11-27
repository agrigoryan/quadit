package server_test

import (
	"slices"
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

// TestATitleIsAddedAfterTheLinkNeverInsideIt: a link's own words, escaped
// as Markdown escapes them, are the title they read; the title the page has
// now goes after the whole link (an address with a part, an autolink),
// never inside its address.
func TestATitleIsAddedAfterTheLinkNeverInsideIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		draft := s.change(t, s.owner, "", "doc.create", M{"title": "Review [draft] | v2", "markdown": "notes\n"})["ref"].(string)
		address := s.url + "/games/docs/" + draft
		written := []string{
			`[Review \[draft\] \| v2](doc:` + draft + `)`,
			`[part two](` + address + `#two)`,
			`<` + address + `>`,
			address + `.`,
		}
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": strings.Join(written, " and ")})
		show := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil)
		named := ` ("Review [draft] | v2")`
		for _, want := range []string{
			written[0] + " and",
			written[1] + named + " and",
			written[2] + named + " and",
			address + named + ".",
		} {
			if !strings.Contains(show, want) {
				t.Errorf("the task as text does not say %s: %s", want, show)
			}
		}
	})
}

// TestEveryLineAnAgentReadsOfACommentNamesItsPages: the feed's line of a
// comment edited, and a page's threads, name a page by id with its title,
// as the line of a comment made does.
func TestEveryLineAnAgentReadsOfACommentNamesItsPages(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		review := s.change(t, s.owner, "", "doc.create", M{"title": "Meta rework review", "markdown": "notes\n"})["ref"].(string)
		named := "doc:" + review + ` ("Meta rework review")`
		said := s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "First draft."})["ref"].(string)
		s.change(t, s.owner, "", "comment.update", M{"id": said, "body": "Now in doc:" + review})
		if out := s.call(t, s.owner, "", "GET", w+"/events?task=SVA-1&types=comment.updated&format=text", nil, 200, nil); !strings.Contains(out, named) {
			t.Errorf("the feed's line of the edit does not name the page: %s", out)
		}
		s.change(t, s.owner, "", "comment.create", M{"doc": review, "body": "Compare with doc:" + review})
		if out := s.call(t, s.owner, "", "GET", w+"/docs/"+review+"/comments?format=text", nil, 200, nil); !strings.Contains(out, named) {
			t.Errorf("the page's threads do not name the page: %s", out)
		}
	})
}

// TestAnAnswerReadsEachPageItNamesOnce: however many times the lines of an
// answer (a task, its context pack, a page of the feed) point at a page, its
// title is read once, and once for a page that is not there.
func TestAnAnswerReadsEachPageItNamesOnce(t *testing.T) {
	t.Parallel()
	st := newFaultyStore(testdb.SQLite(t))
	s := newSite(t, st)
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	review := s.change(t, s.owner, "", "doc.create", M{"title": "Meta rework review", "markdown": "notes\n"})["ref"].(string)
	missing := "01a21abf-0000-7000-8000-00000000dead"
	for range 6 {
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "See doc:" + review + " and doc:" + missing})
	}
	reads := map[string]int{}
	counting := func(_ map[string]any, where []store.Cond) bool {
		for _, c := range where {
			for _, docID := range []string{review, missing} {
				if c.Col == "id" && (c.Val == docID || c.Op == "in" && slices.Contains(c.Val.([]string), docID)) {
					reads[docID]++
				}
			}
		}
		return false // counted, never failed
	}
	st.faults.arm(fault{op: "get", table: "docs", match: counting})
	st.faults.arm(fault{op: "list", table: "docs", match: counting})
	for _, read := range []string{"/tasks/SVA-1?format=text", "/tasks/SVA-1/context?format=text", "/events?task=SVA-1&format=text"} {
		clear(reads)
		out := s.call(t, s.owner, "", "GET", w+read, nil, 200, nil)
		if !strings.Contains(out, `("Meta rework review")`) {
			t.Fatalf("%s does not name the page: %s", read, out)
		}
		if reads[review] != 1 || reads[missing] != 1 {
			t.Errorf("%s read the page %d times and the missing one %d times, want each once", read, reads[review], reads[missing])
		}
	}
}

// TestATitleOnSeveralLinesIsListedOnOne: a page whose title was given on
// several lines is listed on one, in the page tree, on its task and in the
// context pack, and named on one in an agent's text.
func TestATitleOnSeveralLinesIsListedOnOne(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Meta rework\n## review", "markdown": "notes\n"})["ref"].(string)
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "See doc:" + page})
		for read, path := range map[string]string{"the page tree": "/docs?format=text", "the task": "/tasks/SVA-1?format=text", "the context pack": "/tasks/SVA-1/context?format=text"} {
			out := s.call(t, s.owner, "", "GET", w+path, nil, 200, nil)
			if strings.Contains(out, "Meta rework\n") || !strings.Contains(out, "Meta rework ## review") {
				t.Errorf("%s does not give the title on one line: %s", read, out)
			}
		}
	})
}
