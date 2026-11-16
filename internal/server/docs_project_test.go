package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestProjectPages: the pages of one project can be asked for, a page says
// its project in the outline where it is not its parent's, and someone
// limited to a project sees the pages that are moved into it.
func TestProjectPages(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "agent.create", M{"name": "Narrow", "handle": "narrow"})
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"projects": []string{"OPS"}}})
		var tok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@narrow"}, 201, &tok)
		narrow := tok.Token
		page := func(args M) string { return s.change(s.owner, "", "doc.create", args)["ref"].(string) }
		handbook := page(M{"title": "Handbook", "project": "SVA"})
		art := page(M{"title": "Art", "parent": handbook})
		page(M{"title": "Palette", "parent": art, "markdown": "Vermilion and indigo.\n"})
		page(M{"title": "On call", "parent": handbook, "project": "OPS"})
		page(M{"title": "Runbook", "project": "OPS"})
		page(M{"title": "Meeting notes"})
		outline := func(hc bool, query string) string {
			if hc {
				return s.call(s.owner, "", "GET", w+"/docs?format=text"+query, nil, 200, nil)
			}
			return s.call(nil, narrow, "GET", "/api/v1/w/-/docs?format=text"+query, nil, 200, nil)
		}
		lineOf := func(text, title string) string {
			for line := range strings.SplitSeq(text, "\n") {
				if strings.HasPrefix(strings.TrimLeft(line, " "), title) {
					return line
				}
			}
			return ""
		}

		// A project's pages are those tied to it with the pages under them.
		got := outline(true, "&project=SVA")
		for title, want := range map[string]string{"Handbook": "Handbook [SVA]  (", "Art": "  Art  (", "Palette": "    Palette  (", "On call": "  On call [OPS]  ("} {
			if line := lineOf(got, title); !strings.HasPrefix(line, want) {
				t.Fatalf("SVA's pages: the line of %s is %q, want it to start %q\n%s", title, line, want, got)
			}
		}
		if strings.Contains(got, "Runbook") || strings.Contains(got, "Meeting notes") {
			t.Fatalf("SVA's pages hold a page of another project or of none:\n%s", got)
		}
		var listed struct{ Docs []struct{ Title string } }
		s.call(s.owner, "", "GET", w+"/docs?project=ops", nil, 200, &listed)
		if len(listed.Docs) != 2 {
			t.Fatalf("OPS's pages = %+v, want Runbook and On call", listed.Docs)
		}

		// Someone limited to OPS sees its pages and those of no project. A
		// page whose parent they cannot see stands at the top for them.
		got = outline(false, "")
		if strings.Contains(got, "Handbook") || strings.Contains(got, "Palette") {
			t.Fatalf("a member limited to OPS sees SVA's pages:\n%s", got)
		}
		if !strings.HasPrefix(lineOf(got, "On call"), "On call [OPS]  (") || !strings.HasPrefix(lineOf(got, "Meeting notes"), "Meeting notes  (") {
			t.Fatalf("a member limited to OPS should see its pages and those of no project:\n%s", got)
		}
		s.call(nil, narrow, "GET", "/api/v1/w/-/docs?project=SVA", nil, 404, nil)
		s.call(nil, narrow, "GET", "/api/v1/w/-/docs/"+art, nil, 404, nil)
		if found := s.call(nil, narrow, "GET", "/api/v1/w/-/search?q=vermilion", nil, 200, nil); strings.Contains(found, "Palette") {
			t.Fatalf("search shows a member limited to OPS a page of SVA: %s", found)
		}

		// The handbook moves to OPS with what is under it: now they see all of it.
		s.change(s.owner, "", "doc.update", M{"id": handbook, "project": "OPS"})
		got = outline(false, "&project=OPS")
		for _, title := range []string{"Handbook", "Art", "Palette", "On call", "Runbook"} {
			if lineOf(got, title) == "" {
				t.Fatalf("after the move a member limited to OPS does not see %s:\n%s", title, got)
			}
		}
		s.call(nil, narrow, "GET", "/api/v1/w/-/docs/"+art, nil, 200, nil)
		// Their feed brought each page whole, so a browser shows them without asking again.
		if feed := s.call(nil, narrow, "GET", "/api/v1/w/-/events?limit=2000&types=doc.updated", nil, 200, nil); !strings.Contains(feed, `"title":"Palette"`) {
			t.Fatalf("the feed of a member limited to OPS does not bring the pages that moved into it: %s", feed)
		}
		if found := s.call(nil, narrow, "GET", "/api/v1/w/-/search?q=vermilion", nil, 200, nil); !strings.Contains(found, "Palette") {
			t.Fatalf("search does not find a page that moved into the member's project: %s", found)
		}
		// And they cannot send it to a project they do not see.
		s.call(nil, narrow, "POST", "/api/v1/w/-/changes", M{"id": "0192f0c0-0000-7000-8000-0000000000aa", "type": "doc.update", "args": M{"id": handbook, "project": "SVA"}}, 403, nil)
	})
}
