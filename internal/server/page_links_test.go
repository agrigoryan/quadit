package server_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAPageLinkedToATaskIsSeenFromBothSides: a page linked to a task lists
// the task among what mentions it; the task lists the link, the page among
// what it mentions, and its context pack names the page. A reader limited
// to one project is given none of it for a page of another project or
// someone else's private page: not the link, not the reference, not the
// link's event in the feed, and not a page in the pack.
func TestAPageLinkedToATaskIsSeenFromBothSides(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		var shown struct{ Task struct{ ID string } }
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &shown)
		sva := shown.Task.ID
		handbook := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "how we work\n"})["ref"].(string)
		runbook := s.change(t, s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "rotate\n"})["ref"].(string)
		salaries := s.change(t, s.owner, "", "doc.create", M{"title": "Salaries", "private": true, "markdown": "who earns what\n"})["ref"].(string)
		for _, page := range []string{handbook, runbook, salaries} {
			s.change(t, s.owner, "", "link.set", M{"task": "SVA-1", "kind": "doc", "ref": page})
		}

		type ref struct {
			FromScopeID string `json:"from_scope_id"`
			ToID        string `json:"to_id"`
		}
		var page struct {
			MentionedIn []ref `json:"mentioned_in"`
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+handbook, nil, 200, &page)
		if len(page.MentionedIn) != 1 || page.MentionedIn[0].FromScopeID != sva {
			t.Fatalf("the page does not list the task it is linked to: %+v", page.MentionedIn)
		}
		page.MentionedIn = nil
		s.call(t, nil, narrow, "GET", w+"/docs/"+handbook, nil, 200, &page)
		if len(page.MentionedIn) != 1 || page.MentionedIn[0].FromScopeID != sva {
			t.Fatalf("a reader of SVA is not told the page is linked to SVA-1: %+v", page.MentionedIn)
		}

		type link struct {
			Kind string `json:"kind"`
			Ref  string `json:"ref"`
		}
		var rows struct {
			Links    []link `json:"links"`
			Mentions []ref  `json:"mentions"`
		}
		pages := func(rows struct {
			Links    []link `json:"links"`
			Mentions []ref  `json:"mentions"`
		}) (linked, mentioned string) {
			var l, m []string
			for _, x := range rows.Links {
				l = append(l, x.Kind+":"+x.Ref)
			}
			for _, x := range rows.Mentions {
				m = append(m, x.ToID)
			}
			return strings.Join(l, " "), strings.Join(m, " ")
		}
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &rows)
		linked, mentioned := pages(rows)
		for _, id := range []string{handbook, runbook, salaries} {
			if !strings.Contains(linked, "doc:"+id) || !strings.Contains(mentioned, id) {
				t.Fatalf("the owner is not told of every page linked to the task: links %s, mentions %s", linked, mentioned)
			}
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil); !strings.Contains(out, "page Handbook  (doc "+handbook+")") {
			t.Fatalf("the task as text does not name the linked page: %s", out)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1/context", nil, 200, nil); !strings.Contains(out, "Vault runbook") || !strings.Contains(out, "Handbook") {
			t.Fatalf("the context pack does not name the linked pages: %s", out)
		}

		rows.Links, rows.Mentions = nil, nil
		s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &rows)
		linked, mentioned = pages(rows)
		if !strings.Contains(linked, handbook) || !strings.Contains(mentioned, handbook) {
			t.Fatalf("a reader of SVA is not told of the page it may see: links %s, mentions %s", linked, mentioned)
		}
		reads := map[string]string{
			"the task's rows":    linked + " " + mentioned,
			"the task":           s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1", nil, 200, nil),
			"the task as text":   s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil),
			"the list of links":  s.call(t, nil, narrow, "GET", w+"/list/links?task=SVA-1", nil, 200, nil),
			"the task's history": s.call(t, nil, narrow, "GET", w+"/events?task=SVA-1", nil, 200, nil),
			"the context pack":   s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1/context", nil, 200, nil),
		}
		for read, out := range reads {
			for name, id := range map[string]string{"a page of OPS": runbook, "a private page": salaries} {
				if strings.Contains(out, id) {
					t.Errorf("%s tells a reader of SVA of %s: %s", read, name, out)
				}
			}
		}
	})
}

// TestAnAgentLinksAPageFromTheCommandLine: quadit link KEY page=ID links a
// page to a task, and the agent then reads it on the task and in its
// context pack, as a page it may see.
func TestAnAgentLinksAPageFromTheCommandLine(t *testing.T) {
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv).
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		handbook := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "how we work\n"})["ref"].(string)
		if out, code := s.quadit(t, narrow, "link", "SVA-1", "page="+handbook); code != 0 {
			t.Fatalf("quadit link SVA-1 page=ID failed (%d): %s", code, out)
		}
		if out, _ := s.quadit(t, narrow, "show", "SVA-1"); !strings.Contains(out, "page Handbook") {
			t.Fatalf("the task does not show the page linked to it: %s", out)
		}
		if out, _ := s.quadit(t, narrow, "context", "SVA-1"); !strings.Contains(out, "Handbook") {
			t.Fatalf("the context pack does not name the page linked to the task: %s", out)
		}
		// The same link written from the page's side is the same change.
		runbook := s.change(t, s.owner, "", "doc.create", M{"title": "Runbook", "markdown": "rotate\n"})["ref"].(string)
		if out, code := s.quadit(t, narrow, "link", "page="+runbook, "task=SVA-1"); code != 0 {
			t.Fatalf("quadit link page=ID task=KEY failed (%d): %s", code, out)
		}
		if out, _ := s.quadit(t, narrow, "show", "SVA-1"); !strings.Contains(out, "page Runbook") {
			t.Fatalf("the task does not show the page linked from the page's side: %s", out)
		}
	})
}

// TestATaskListsEachPageItAndThePageMentionOnce: quadit show lists, as
// "page TITLE  (doc ID)", every page the task and a page point at each
// other through, once each: one linked to it, one its description or a
// comment mentions, one whose text mentions the task. A page the reader may
// not see is left out.
func TestATaskListsEachPageItAndThePageMentionOnce(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		handbook := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "how we work\n"})["ref"].(string)
		runbook := s.change(t, s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "rotate\n"})["ref"].(string)
		notes := s.change(t, s.owner, "", "doc.create", M{"title": "Boss notes", "markdown": "Three phases, see SVA-1.\n"})["ref"].(string)
		review := s.change(t, s.owner, "", "doc.create", M{"title": "Meta rework review", "markdown": "what we found\n"})["ref"].(string)
		s.change(t, s.owner, "", "link.set", M{"task": "SVA-1", "kind": "doc", "ref": handbook})
		s.change(t, s.owner, "", "task.update", M{"id": "SVA-1", "description": "Follow [Handbook](doc:" + handbook + ")."})
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "Again doc:" + handbook + ", and [Meta rework review](doc:" + review + ") and doc:" + runbook})

		lines := map[string]string{
			"the linked page, also mentioned": "page Handbook  (doc " + handbook + ")\n",
			"a page a comment mentions":       "page Meta rework review  (doc " + review + ")\n",
			"a page that mentions the task":   "page Boss notes  (doc " + notes + ")\n",
		}
		for reader, token := range map[string]string{"the owner": "", "a reader of SVA": narrow} {
			client := s.owner
			if token != "" {
				client = nil
			}
			out := s.call(t, client, token, "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil)
			for what, line := range lines {
				if n := strings.Count(out, line); n != 1 {
					t.Errorf("%s is shown %s %d times, not once: %s", reader, what, n, out)
				}
			}
			ops := strings.Contains(out, "page Vault runbook  (doc "+runbook+")")
			if ops != (token == "") {
				t.Errorf("%s is shown the page of OPS a comment mentions: %v, wrongly: %s", reader, ops, out)
			}
		}

		var detail struct {
			Pages []struct{ ID, Title, URL string }
		}
		s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1", nil, 200, &detail)
		var titles []string
		for _, p := range detail.Pages {
			titles = append(titles, p.Title)
			if !strings.HasSuffix(p.URL, "/docs/"+p.ID) {
				t.Errorf("the page %s is not given at its address: %s", p.Title, p.URL)
			}
		}
		if got := strings.Join(titles, ", "); got != "Boss notes, Handbook, Meta rework review" {
			t.Errorf("the task's pages, by title, are %q", got)
		}
	})
}

// TestWritingANewPageGivesTheLinkToIt: quadit write new TITLE prints, after
// the page's id, the Markdown that points a person at the page, ready to
// paste into a comment or a result.
func TestWritingANewPageGivesTheLinkToIt(t *testing.T) {
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv) and stdin.
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		agent := s.agentToken(t, "writer")
		body := filepath.Join(t.TempDir(), "review.md")
		if err := os.WriteFile(body, []byte("what we found\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(body)
		if err != nil {
			t.Fatal(err)
		}
		was := os.Stdin
		os.Stdin = f
		out, code := s.quadit(t, agent, "write", "new", "Meta [rework] review")
		os.Stdin = was
		f.Close()
		made := regexp.MustCompile(`ok doc.create id=(\S+)`).FindStringSubmatch(out)
		if code != 0 || made == nil {
			t.Fatalf("quadit write new failed (%d): %s", code, out)
		}
		if want := `link: [Meta \[rework\] review](doc:` + made[1] + ")\n"; !strings.Contains(out, want) {
			t.Fatalf("quadit write new does not print %q: %s", want, out)
		}
	})
}

// TestATaskLeavesOutAPageLinkedToItThatIsInTheTrash: a page linked to a
// task and then moved to the trash is not named on the task, among its
// links no more than among its pages; back from the trash, it is there
// again. (The task's rows keep the link's row, which names no page: the
// web app's copy shows the page as gone, and as back when it is restored.)
func TestATaskLeavesOutAPageLinkedToItThatIsInTheTrash(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		oneProjectOnly(t, s)
		plan := s.change(t, s.owner, "", "doc.create", M{"title": "Secret plan", "markdown": "first try\n"})["ref"].(string)
		s.change(t, s.owner, "", "link.set", M{"task": "SVA-1", "kind": "doc", "ref": plan})
		reads := func() map[string]string {
			return map[string]string{
				"the task":         s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, nil),
				"the task as text": s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil),
				"the context pack": s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1/context", nil, 200, nil),
			}
		}
		s.change(t, s.owner, "", "doc.delete", M{"id": plan})
		for read, out := range reads() {
			if strings.Contains(out, plan) || strings.Contains(out, "Secret plan") {
				t.Errorf("%s names the page in the trash: %s", read, out)
			}
		}
		s.change(t, s.owner, "", "doc.restore", M{"id": plan})
		if out := reads()["the task"]; !strings.Contains(out, "Secret plan") {
			t.Errorf("the page back from the trash is not on the task: %s", out)
		}
	})
}

// TestAContextPackListsEachPageOnce: the context pack lists each page the
// task and a page point at each other through once, under "linked docs".
func TestAContextPackListsEachPageOnce(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		oneProjectOnly(t, s)
		handbook := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "how we work\n"})["ref"].(string)
		s.change(t, s.owner, "", "link.set", M{"task": "SVA-1", "kind": "doc", "ref": handbook})
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "Read [Handbook](doc:" + handbook + ")"})
		out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1/context?format=text", nil, 200, nil)
		if n := strings.Count(out, "Handbook  (doc "+handbook+")"); n != 1 || !strings.Contains(out, "=== linked docs\nHandbook  (doc "+handbook+")") {
			t.Errorf("the context pack lists the page %d times, not once under linked docs: %s", n, out)
		}
	})
}
