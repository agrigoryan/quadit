package server_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestATokenForSomeProjectsReadsItsMembersOwnListsOfThoseOnly: a token made
// for some projects narrows what is the member's own as it narrows the
// rest: the inbox, My work, the unread count, the feed's inbox items and
// the watched things in the starting copy say nothing of another project's
// tasks, though the member's other ways in show them.
func TestATokenForSomeProjectsReadsItsMembersOwnListsOfThoseOnly(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		oneProjectOnly(t, s)
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "SVA only", "projects": []string{"SVA"}}, 201, &tok)
		s.change(t, s.owner, "", "agent.create", M{"name": "Ops bot", "handle": "ops"})
		var opsTok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@ops"}, 201, &opsTok)
		s.change(t, s.owner, "", "watch.set", M{"subject": "SVA-1"})
		s.change(t, s.owner, "", "watch.set", M{"subject": "OPS-1"})
		s.change(t, nil, opsTok.Token, "comment.create", M{"task": "SVA-1", "body": "Drew it."})
		s.change(t, nil, opsTok.Token, "comment.create", M{"task": "OPS-1", "body": "Rotated it."})
		s.change(t, nil, opsTok.Token, "decision.open", M{"task": "OPS-1", "question": "Which vault?", "options": []M{{"label": "Ours"}, {"label": "Theirs"}}, "ask": "@aram"})
		opsTask := struct{ ID string }{}
		s.call(t, s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &struct{ Task *struct{ ID string } }{Task: &opsTask})

		for _, path := range []string{"/inbox?all=1", "/my-work"} {
			if out := s.call(t, s.owner, "", "GET", w+path, nil, 200, nil); !strings.Contains(out, "OPS-1") {
				t.Fatalf("%s does not show the member's own OPS-1 items when signed in: %s", path, out)
			}
			out := s.call(t, nil, tok.Token, "GET", w+path, nil, 200, nil)
			if strings.Contains(out, "OPS-1") || strings.Contains(out, "Which vault?") {
				t.Fatalf("%s, read with a token for SVA, tells of OPS-1: %s", path, out)
			}
			if !strings.Contains(out, "SVA-1") {
				t.Fatalf("%s, read with a token for SVA, leaves out SVA-1: %s", path, out)
			}
		}

		var me struct{ Unread int }
		var inbox struct{ Inbox []json.RawMessage }
		s.call(t, nil, tok.Token, "GET", w+"/me", nil, 200, &me)
		s.call(t, nil, tok.Token, "GET", w+"/inbox", nil, 200, &inbox)
		if me.Unread != len(inbox.Inbox) {
			t.Fatalf("the token is told of %d unread items and shown %d", me.Unread, len(inbox.Inbox))
		}

		if out := s.call(t, nil, tok.Token, "GET", w+"/events?inbox=1", nil, 200, nil); strings.Contains(out, "OPS-1") || strings.Contains(out, opsTask.ID) {
			t.Fatalf("the feed, read with a token for SVA, gives inbox items of OPS-1: %s", out)
		}

		var copied struct {
			Notifications []struct {
				TaskID string `json:"task_id"`
			}
			Watchers []struct {
				SubjectID string `json:"subject_id"`
			}
		}
		s.call(t, nil, tok.Token, "GET", w+"/bootstrap", nil, 200, &copied)
		if len(copied.Notifications) == 0 || len(copied.Watchers) == 0 {
			t.Fatalf("the starting copy brings none of the member's own rows: %+v", copied)
		}
		for _, n := range copied.Notifications {
			if n.TaskID == opsTask.ID {
				t.Fatalf("the starting copy, read with a token for SVA, brings an inbox item of OPS-1")
			}
		}
		for _, watching := range copied.Watchers {
			if watching.SubjectID == opsTask.ID {
				t.Fatalf("the starting copy, read with a token for SVA, says the member watches OPS-1")
			}
		}
	})
}

// TestAnInboxItemOfAProjectAMemberWasKeptOutOfIsNotShown: a member waited
// on in a project they were since kept out of is not told of that task by
// their inbox, My work or the unread count.
func TestAnInboxItemOfAProjectAMemberWasKeptOutOfIsNotShown(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Ops bot", "handle": "ops"})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@ops"}, 201, &tok)
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Patch the kernel", "waiting_on": "@ops", "assignee": "@ops"})
		s.change(t, s.owner, "", "agent.update", M{"id": "@ops", "scope": M{"projects": []string{"SVA"}}})

		for _, path := range []string{"/inbox?all=1", "/my-work", "/my-work?format=text"} {
			if out := s.call(t, nil, tok.Token, "GET", w+path, nil, 200, nil); strings.Contains(out, "OPS-1") || strings.Contains(out, "kernel") {
				t.Fatalf("%s tells the member of a task of a project they were kept out of: %s", path, out)
			}
		}
		var me struct{ Unread int }
		s.call(t, nil, tok.Token, "GET", w+"/me", nil, 200, &me)
		if me.Unread != 0 {
			t.Fatalf("the member is told of %d unread items, want none", me.Unread)
		}
	})
}
