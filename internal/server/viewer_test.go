package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// oneProjectOnly makes two projects, SVA and OPS, each with a task, and
// returns the token of an agent that may read SVA alone.
func oneProjectOnly(t *testing.T, s *site) (narrow string) {
	t.Helper()
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
	s.change(s.owner, "", "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}})
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@narrow"}, 201, &tok)
	return tok.Token
}

// TestContextPackLeavesOutPagesOfOtherProjects: a task's context pack
// names the pages that mention it, and a page of a project the caller may
// not read is not one of them, as it is not in the page tree.
func TestContextPackLeavesOutPagesOfOtherProjects(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		s.change(s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "As in SVA-1."})
		for _, form := range []string{"", "?format=text"} {
			if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-1/context"+form, nil, 200, nil); !strings.Contains(out, "Vault runbook") {
				t.Fatalf("the pack does not name the page to someone who may read it: %s", out)
			}
			if out := s.call(nil, narrow, "GET", w+"/tasks/SVA-1/context"+form, nil, 200, nil); strings.Contains(out, "Vault runbook") {
				t.Fatalf("the pack names a page of a project the caller may not read: %s", out)
			}
		}
	})
}

// TestAViewOfAnotherProjectIsNotThere: a shared view of a project the
// caller may not read is not theirs to open, by slug, by id or by name, and
// is not among the views a wrong name is answered with.
func TestAViewOfAnotherProjectIsNotThere(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		ops := s.change(s.owner, "", "view.create", M{"name": "Ops work", "project": "OPS", "query": M{"open": true}})["ref"].(string)
		s.change(s.owner, "", "view.create", M{"name": "Art work", "project": "SVA", "query": M{"open": true}})
		s.call(s.owner, "", "GET", w+"/tasks?view=ops-work", nil, 200, nil)
		s.call(nil, narrow, "GET", w+"/tasks?view=art-work", nil, 200, nil)
		for _, ref := range []string{"ops-work", ops, "Ops+work"} {
			if out := s.call(nil, narrow, "GET", w+"/tasks?view="+ref, nil, 404, nil); strings.Contains(out, "ops-work") && ref != "ops-work" || strings.Contains(out, "OPS") {
				t.Fatalf("view=%s tells of a view the caller may not see: %s", ref, out)
			}
		}
		if out := s.call(nil, narrow, "GET", w+"/tasks?view=nope", nil, 404, nil); strings.Contains(out, "ops-work") || !strings.Contains(out, "art-work") {
			t.Fatalf("the views a wrong name is answered with: %s", out)
		}
	})
}

// TestTheStartingCopyKeepsRelationsToReadableTasks: a relation is seen by
// whoever may read the task it is on, in the starting copy as in
// /list/relations. One made on a task of another project is not brought,
// though it points at a task the caller may read.
func TestTheStartingCopyKeepsRelationsToReadableTasks(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss music"})
		hidden := s.change(s.owner, "", "relation.add", M{"task": "OPS-1", "type": "duplicates", "other": "SVA-1"})["ref"].(string)
		shown := s.change(s.owner, "", "relation.add", M{"task": "SVA-1", "type": "blocks", "other": "SVA-2"})["ref"].(string)
		for _, path := range []string{"/bootstrap", "/bootstrap?part=open", "/list/relations"} {
			if out := s.call(s.owner, "", "GET", w+path, nil, 200, nil); !strings.Contains(out, hidden) || !strings.Contains(out, shown) {
				t.Fatalf("%s does not give every relation to someone who may read both projects: %s", path, out)
			}
			var got struct{ Relations []struct{ ID string } }
			s.call(nil, narrow, "GET", w+path, nil, 200, &got)
			if len(got.Relations) != 1 || got.Relations[0].ID != shown {
				t.Fatalf("%s gives a caller limited to SVA the relations %+v, want only the one made on SVA-1", path, got.Relations)
			}
		}
	})
}
