package server_test

import (
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
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		var shown struct{ Task struct{ ID string } }
		s.call(s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &shown)
		sva := shown.Task.ID
		handbook := s.change(s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "how we work\n"})["ref"].(string)
		runbook := s.change(s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "rotate\n"})["ref"].(string)
		salaries := s.change(s.owner, "", "doc.create", M{"title": "Salaries", "private": true, "markdown": "who earns what\n"})["ref"].(string)
		for _, page := range []string{handbook, runbook, salaries} {
			s.change(s.owner, "", "link.set", M{"task": "SVA-1", "kind": "doc", "ref": page})
		}

		type ref struct {
			FromScopeID string `json:"from_scope_id"`
			ToID        string `json:"to_id"`
		}
		var page struct {
			MentionedIn []ref `json:"mentioned_in"`
		}
		s.call(s.owner, "", "GET", w+"/docs/"+handbook, nil, 200, &page)
		if len(page.MentionedIn) != 1 || page.MentionedIn[0].FromScopeID != sva {
			t.Fatalf("the page does not list the task it is linked to: %+v", page.MentionedIn)
		}
		page.MentionedIn = nil
		s.call(nil, narrow, "GET", w+"/docs/"+handbook, nil, 200, &page)
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
		s.call(s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &rows)
		linked, mentioned := pages(rows)
		for _, id := range []string{handbook, runbook, salaries} {
			if !strings.Contains(linked, "doc:"+id) || !strings.Contains(mentioned, id) {
				t.Fatalf("the owner is not told of every page linked to the task: links %s, mentions %s", linked, mentioned)
			}
		}
		if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil); !strings.Contains(out, "page Handbook  (doc "+handbook+")") {
			t.Fatalf("the task as text does not name the linked page: %s", out)
		}
		if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-1/context", nil, 200, nil); !strings.Contains(out, "Vault runbook") || !strings.Contains(out, "Handbook") {
			t.Fatalf("the context pack does not name the linked pages: %s", out)
		}

		rows.Links, rows.Mentions = nil, nil
		s.call(nil, narrow, "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &rows)
		linked, mentioned = pages(rows)
		if !strings.Contains(linked, handbook) || !strings.Contains(mentioned, handbook) {
			t.Fatalf("a reader of SVA is not told of the page it may see: links %s, mentions %s", linked, mentioned)
		}
		reads := map[string]string{
			"the task's rows":    linked + " " + mentioned,
			"the task":           s.call(nil, narrow, "GET", w+"/tasks/SVA-1", nil, 200, nil),
			"the task as text":   s.call(nil, narrow, "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil),
			"the list of links":  s.call(nil, narrow, "GET", w+"/list/links?task=SVA-1", nil, 200, nil),
			"the task's history": s.call(nil, narrow, "GET", w+"/events?task=SVA-1", nil, 200, nil),
			"the context pack":   s.call(nil, narrow, "GET", w+"/tasks/SVA-1/context", nil, 200, nil),
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
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		handbook := s.change(s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "how we work\n"})["ref"].(string)
		if out, code := s.quadit(narrow, "link", "SVA-1", "page="+handbook); code != 0 {
			t.Fatalf("quadit link SVA-1 page=ID failed (%d): %s", code, out)
		}
		if out, _ := s.quadit(narrow, "show", "SVA-1"); !strings.Contains(out, "page Handbook") {
			t.Fatalf("the task does not show the page linked to it: %s", out)
		}
		if out, _ := s.quadit(narrow, "context", "SVA-1"); !strings.Contains(out, "Handbook") {
			t.Fatalf("the context pack does not name the page linked to the task: %s", out)
		}
	})
}
