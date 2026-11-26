package server_test

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestEveryReadAnswersEachCallerTheSame holds every read the server has to
// what it answers today, for four callers who may see different things: the
// workspace's admin, a member limited to one project, an admin's token
// limited to one project, and a read-only member. One workspace with a
// little of everything is made (richWorkspace), then every GET route is
// called as each of them and the status and body written to
// testdata/reads/<caller>.golden, with ids, times and addresses made the
// same on every run. A route the server has that the test does not call
// fails it, so a new read is recorded or says why it is not.
//
// The files are what "who may see what" is today. A change to one is either
// a mistake or a change of access, and is looked at line by line. Run with
// QUADIT_UPDATE_READS=1 to write them again; QUADIT_READS_GOT=dir writes
// what a failing run got there, to compare by hand.
//
// The files are SQLite's answers. Postgres finds and orders some things
// differently (search, rows made in the same change, lists read without an
// order), so there only the status of each answer is compared with them. To
// hold Postgres to its own bodies while changing the reads, name a
// directory for them in QUADIT_READS_DIR: its answers are written there,
// and compared with the lines of each answer in the order of their text.
func TestEveryReadAnswersEachCallerTheSame(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		rw := newRichWorkspace(t, s, st)
		for _, who := range rw.callers {
			rec := &recording{rw: rw, who: who}
			rec.everyRead()
			compareWithRecorded(t, who.name+".golden", rec.out.String())
		}
		rw.everyGetRouteWasCalled()
	})
}

// compareWithRecorded compares a recording with its file, or writes the
// file when QUADIT_UPDATE_READS is set.
func compareWithRecorded(t *testing.T, name, got string) {
	t.Helper()
	sqlite := strings.Contains(t.Name(), "/sqlite")
	dir, form := os.Getenv("QUADIT_READS_DIR"), linesInAnyOrder
	if dir == "" {
		dir, form = "testdata/reads", statusesOf
	}
	if sqlite {
		form = func(rec string) string { return rec }
	}
	file := filepath.Join(dir, name)
	if os.Getenv("QUADIT_UPDATE_READS") != "" {
		if sqlite || dir != "testdata/reads" {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	want := string(raw)
	if gotDir := os.Getenv("QUADIT_READS_GOT"); gotDir != "" && got != want {
		if err := os.WriteFile(filepath.Join(gotDir, name), []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, want = form(got), form(want)
	if got == want {
		return
	}
	gotAnswers, wantAnswers := strings.Split(got, "\n=== "), strings.Split(want, "\n=== ")
	for i := 0; i < len(gotAnswers) || i < len(wantAnswers); i++ {
		g, w := lineAt(gotAnswers, i), lineAt(wantAnswers, i)
		if g == w {
			continue
		}
		gl, wl := strings.Split(g, "\n"), strings.Split(w, "\n")
		for j := 0; j < len(gl) || j < len(wl); j++ {
			if lineAt(gl, j) != lineAt(wl, j) {
				t.Errorf("%s: the answer to %q changed at its line %d:\n got  %s\n want %s", file, gl[0], j, lineAt(gl, j), lineAt(wl, j))
				break
			}
		}
		return
	}
}

func lineAt(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return "(none)"
}

var numberedID = regexp.MustCompile(`<id #\d+>`)

// statusesOf is a recording with only what was asked and the status of each
// answer, in the order of what was asked, and the ids that are numbered in
// the order they were met alike.
func statusesOf(rec string) string {
	answers := strings.Split(numberedID.ReplaceAllString(rec, "<id>"), "\n=== ")
	for i, answer := range answers {
		lines := strings.SplitN(answer, "\n", 3)
		answers[i] = strings.Join(lines[:min(2, len(lines))], "\n")
	}
	sort.Strings(answers)
	return strings.Join(answers, "\n=== ")
}

// linesInAnyOrder is a recording with the lines of each answer in the order
// of their text, and the numbered ids alike: what stays the same when a
// database orders a list its own way.
func linesInAnyOrder(rec string) string {
	answers := strings.Split(numberedID.ReplaceAllString(rec, "<id>"), "\n=== ")
	for i, answer := range answers {
		asked, body, _ := strings.Cut(answer, "\n")
		lines := strings.Split(body, "\n")
		for j := range lines {
			lines[j] = strings.TrimSuffix(lines[j], ",")
		}
		sort.Strings(lines)
		answers[i] = asked + "\n" + strings.Join(lines, "\n")
	}
	sort.Strings(answers)
	return strings.Join(answers, "\n=== ")
}

// caller is one of those the reads are recorded for.
type caller struct {
	name  string
	hc    *http.Client // signed in by cookie, or nil
	token string       // or an API token
}

// richWorkspace is a workspace with a little of everything a read can
// show, and the ids the recording asks by.
type richWorkspace struct {
	t  *testing.T
	s  *site
	st store.Store
	n  *normaliser

	callers []caller
	artist  string // the token of the agent @artist, limited to SVA
	ops     string // the token of the agent @ops

	ids map[string]string // what the recording asks by: a name -> an id
	// called notes each GET route that was asked, as its pattern.
	called map[string]bool
	hook   *receiver
}

func (rw *richWorkspace) id(name string) string {
	rw.t.Helper()
	v, ok := rw.ids[name]
	if !ok {
		rw.t.Fatalf("the workspace has nothing called %q", name)
	}
	return v
}

// newRichWorkspace makes the workspace. The order of what it does is the
// order of the feed, so adding to it moves every position after: add at the
// end of a part, and write the files again.
func newRichWorkspace(t *testing.T, s *site, st store.Store) *richWorkspace {
	t.Helper()
	rw := &richWorkspace{t: t, s: s, st: st, n: newNormaliser(s.url), ids: map[string]string{}, called: map[string]bool{}}
	rw.n.replace(s.dir, "<data>")
	owner := s.owner
	// Rows that a list orders by when they were made are made in different
	// milliseconds, so the order is the same on every run.
	change := func(hc *http.Client, token, typ string, args any) map[string]any {
		t.Helper()
		time.Sleep(2 * time.Millisecond)
		return s.change(t, hc, token, typ, args)
	}
	made := func(name string, res map[string]any) string {
		t.Helper()
		ref, _ := res["ref"].(string)
		if ref == "" {
			t.Fatalf("%s: the change gave no ref: %v", name, res)
		}
		rw.ids[name] = ref
		rw.n.name(ref, name)
		return ref
	}
	do := func(name, typ string, args M) string { t.Helper(); return made(name, change(owner, "", typ, args)) }
	as := func(token, name, typ string, args M) string {
		t.Helper()
		return made(name, change(nil, token, typ, args))
	}
	day := func(offset int) string { return time.Now().UTC().AddDate(0, 0, offset).Format("2006-01-02") }

	// People, agents and projects.
	rw.n.name(s.ownerID(t), "@aram")
	do("project SVA", "project.create", M{"key": "SVA", "name": "Samurai vs Alien", "description": "The game."})
	do("project OPS", "project.create", M{"key": "OPS", "name": "Operations"})
	do("project ARC", "project.create", M{"key": "ARC", "name": "Archived project"})
	do("project DEL", "project.create", M{"key": "DEL", "name": "Deleted project"})
	bea, beaID := rw.invited("Bea", "bea@example.com")
	cy, cyID := rw.invited("Cy", "cy@example.com")
	_, deeID := rw.invited("Dee", "dee@example.com")
	rw.n.name(beaID, "@bea")
	rw.n.name(cyID, "@cy")
	rw.n.name(deeID, "@dee")
	change(owner, "", "member.update", M{"id": "@bea", "scope": M{"projects": []string{"SVA"}}})
	change(owner, "", "member.update", M{"id": "@cy", "scope": M{"read_only": true}})
	change(owner, "", "member.remove", M{"id": "@dee"})
	do("@artist", "agent.create", M{"name": "Artist", "handle": "artist", "scope": M{"projects": []string{"SVA"}}, "handoff_limit": 5})
	do("@ops", "agent.create", M{"name": "Ops bot", "handle": "ops"})
	token := func(body M) string {
		t.Helper()
		var tok struct{ Token string }
		time.Sleep(2 * time.Millisecond)
		s.call(t, owner, "", "POST", w+"/tokens", body, 201, &tok)
		return tok.Token
	}
	rw.artist = token(M{"user": "@artist", "name": "artist"})
	rw.ops = token(M{"user": "@ops", "name": "ops"})
	rw.callers = []caller{
		{name: "admin", hc: owner},
		{name: "member-one-project", hc: bea},
		{name: "token-one-project", token: token(M{"name": "sva only", "projects": []string{"SVA"}})},
		{name: "member-read-only", hc: cy},
	}

	// What projects have: statuses, labels, epics, milestones, cycles,
	// templates and standing preferences; one of each also deleted.
	do("status Review", "status.create", M{"project": "SVA", "name": "Review", "category": "started"})
	do("label bug", "label.create", M{"name": "bug"})
	do("label art", "label.create", M{"name": "art", "project": "SVA"})
	do("label infra", "label.create", M{"name": "infra", "project": "OPS"})
	do("label temp", "label.create", M{"name": "temp"})
	do("label gone", "label.create", M{"name": "gone", "project": "OPS"})
	change(owner, "", "label.delete", M{"id": rw.id("label gone")})
	do("epic Boss fight", "epic.create", M{"project": "SVA", "name": "Boss fight", "description": "The last level.", "target_on": day(30), "lead": "@aram"})
	do("epic Hardening", "epic.create", M{"project": "OPS", "name": "Hardening", "description": "Keys and backups."})
	do("epic Scrapped", "epic.create", M{"project": "SVA", "name": "Scrapped"})
	do("milestone Alpha", "milestone.create", M{"epic": rw.id("epic Boss fight"), "name": "Alpha", "target_on": day(14)})
	do("milestone Audit", "milestone.create", M{"epic": rw.id("epic Hardening"), "name": "Audit"})
	do("milestone Dropped", "milestone.create", M{"epic": rw.id("epic Scrapped"), "name": "Dropped"})
	do("milestone Removed", "milestone.create", M{"epic": rw.id("epic Boss fight"), "name": "Removed"})
	change(owner, "", "milestone.delete", M{"id": rw.id("milestone Removed")})
	change(owner, "", "epic.delete", M{"id": rw.id("epic Scrapped")})
	do("cycle SVA now", "cycle.create", M{"project": "SVA", "name": "Sprint", "starts_on": day(-3), "ends_on": day(10)})
	do("cycle SVA next", "cycle.create", M{"project": "SVA", "starts_on": day(11), "ends_on": day(24)})
	do("cycle OPS now", "cycle.create", M{"project": "OPS", "starts_on": day(-1), "ends_on": day(5)})
	do("cycle SVA gone", "cycle.create", M{"project": "SVA", "starts_on": day(25), "ends_on": day(30)})
	change(owner, "", "cycle.delete", M{"id": rw.id("cycle SVA gone")})
	do("template Bug report", "template.create", M{"name": "Bug report", "title": "Bug: ", "description": "Steps to reproduce"})
	do("template Sprite", "template.create", M{"project": "SVA", "name": "Sprite", "title": "Sprite: "})
	do("template Runbook", "template.create", M{"project": "OPS", "name": "Runbook", "title": "Runbook: "})
	do("template gone", "template.create", M{"project": "OPS", "name": "Gone"})
	change(owner, "", "template.delete", M{"id": rw.id("template gone")})
	do("preference short", "preference.create", M{"body": "Write short."})
	do("preference rings", "preference.create", M{"body": "Explosions are ring-shaped.", "project": "SVA", "labels": []string{"art"}})
	do("preference rotate", "preference.create", M{"body": "Rotate keys monthly.", "project": "OPS"})
	do("preference retired", "preference.create", M{"body": "Retired rule.", "project": "OPS"})
	change(owner, "", "preference.update", M{"id": rw.id("preference retired"), "retired": true})
	do("preference gone", "preference.create", M{"body": "Deleted rule."})
	change(owner, "", "preference.delete", M{"id": rw.id("preference gone")})

	// Tasks of the two projects, made in turn; sub-tasks; done, archived
	// and in the trash.
	task := func(args M) string {
		t.Helper()
		res := change(owner, "", "task.create", args)
		key, _ := res["key"].(string)
		return made("task "+key, res)
	}
	task(M{"project": "SVA", "title": "Boss design", "description": "Four phases.\n\nThe last one flies. See OPS-1.", "epic": "Boss fight", "milestone": "Alpha",
		"cycle": "current", "assignee": "@artist", "waiting_on": "@aram", "priority": 2, "labels": []string{"art", "bug"}, "estimate": 3, "due_on": day(5),
		"handoff_limit": 2})
	task(M{"project": "OPS", "title": "Rotate keys", "description": "Every key in the vault.", "epic": "Hardening", "milestone": "Audit", "cycle": "current",
		"assignee": "@aram", "labels": []string{"infra"}, "priority": 1})
	task(M{"project": "SVA", "title": "Explosion effect", "parent": "SVA-1", "assignee": "@bea", "labels": []string{"art"}})
	task(M{"project": "OPS", "title": "Back up nightly", "parent": "OPS-1", "assignee": "@ops", "waiting_on": "@cy"})
	task(M{"project": "SVA", "title": "Boss music", "epic": "Boss fight", "estimate": 2})
	task(M{"project": "OPS", "title": "Old server"})
	task(M{"project": "SVA", "title": "Old idea"})
	task(M{"project": "OPS", "title": "Shelved audit"})
	task(M{"project": "SVA", "title": "Shelved sketch"})
	task(M{"project": "OPS", "title": "Patch the kernel", "waiting_on": "@cy"})
	task(M{"project": "SVA", "title": "Review me", "status": "Review", "waiting_on": "@bea", "waiting_on_note": "needs a look"})
	task(M{"project": "ARC", "title": "In an archived project"})
	task(M{"project": "DEL", "title": "In a deleted project"})
	change(owner, "", "task.update", M{"id": "SVA-3", "status": "done"})
	change(owner, "", "task.update", M{"id": "OPS-5", "status": "done"})
	change(owner, "", "task.delete", M{"id": "SVA-4"})
	change(owner, "", "task.delete", M{"id": "OPS-3"})
	change(owner, "", "task.update", M{"id": "SVA-5", "archived": true})
	change(owner, "", "task.update", M{"id": "OPS-4", "archived": true})
	change(owner, "", "project.update", M{"id": "ARC", "archived": true})
	change(owner, "", "project.delete", M{"id": "DEL"})

	// Relations inside a project and across the two; links; one of each removed.
	do("relation SVA-1 blocks SVA-2", "relation.add", M{"task": "SVA-1", "type": "blocks", "other": "SVA-2"})
	do("relation SVA-1 relates OPS-1", "relation.add", M{"task": "SVA-1", "type": "relates", "other": "OPS-1"})
	do("relation OPS-1 blocks OPS-2", "relation.add", M{"task": "OPS-1", "type": "blocks", "other": "OPS-2"})
	do("relation OPS-2 duplicates SVA-3", "relation.add", M{"task": "OPS-2", "type": "duplicates", "other": "SVA-3"})
	do("relation removed", "relation.add", M{"task": "SVA-6", "type": "relates", "other": "SVA-1"})
	change(owner, "", "relation.remove", M{"id": rw.id("relation removed")})
	do("link SVA-1 pr", "link.set", M{"task": "SVA-1", "kind": "pr", "repo": "games/sva", "ref": "12", "title": "Boss phases", "url": "https://git.example.com/games/sva/pull/12", "state": "open", "checks": "passing"})
	do("link OPS-1 branch", "link.set", M{"task": "OPS-1", "kind": "branch", "repo": "games/ops", "ref": "rotate-keys"})
	do("link removed", "link.set", M{"task": "SVA-1", "kind": "url", "url": "https://example.com/gone"})
	change(owner, "", "link.remove", M{"id": rw.id("link removed")})

	// Decisions, comments and files.
	file := func(name, body string) string {
		t.Helper()
		var f struct{ ID, State string }
		time.Sleep(2 * time.Millisecond)
		s.call(t, owner, "", "POST", w+"/files?name="+name, []byte(body), 201, &f)
		if f.State != "ready" {
			t.Fatalf("upload of %s = %+v", name, f)
		}
		rw.ids["file "+name] = f.ID
		rw.n.name(f.ID, "file "+name)
		return f.ID
	}
	// option is the id of a decision's nth option, which a comment or a file
	// on it is given by.
	option := func(task, decision string, n int) string {
		t.Helper()
		var detail struct {
			Decisions []struct {
				ID      string
				Options []struct{ ID string }
			}
		}
		s.call(t, owner, "", "GET", w+"/tasks/"+task, nil, 200, &detail)
		for _, d := range detail.Decisions {
			if d.ID == rw.id(decision) {
				return d.Options[n-1].ID
			}
		}
		t.Fatalf("%s has no %s", task, decision)
		return ""
	}
	as(rw.artist, "decision SVA-1 explosion", "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "details": "It is seen from far away.",
		"options": []M{{"label": "Ring", "description": "one clean ring"}, {"label": "Burst"}}, "recommended": 1})
	change(owner, "", "decision.pick", M{"id": rw.id("decision SVA-1 explosion"), "option": 2, "note": "reads better small"})
	as(rw.artist, "decision SVA-1 phases", "decision.open", M{"task": "SVA-1", "question": "How many phases?", "options": []M{{"label": "Three"}, {"label": "Four"}}, "ask": "@aram"})
	do("decision SVA-2 color", "decision.open", M{"task": "SVA-2", "question": "Which color?", "options": []M{{"label": "Red"}, {"label": "Blue"}}, "ask": "@bea"})
	as(rw.ops, "decision OPS-1 vault", "decision.open", M{"task": "OPS-1", "question": "Which vault?", "options": []M{{"label": "Ours"}, {"label": "Theirs"}}})
	change(owner, "", "decision.pick", M{"id": rw.id("decision OPS-1 vault"), "option": 1})
	as(rw.ops, "decision OPS-1 window", "decision.open", M{"task": "OPS-1", "question": "Which night?", "options": []M{{"label": "Monday"}, {"label": "Friday"}}, "ask": "@cy"})
	do("decision removed", "decision.open", M{"task": "SVA-1", "question": "Asked by mistake?", "options": []M{{"label": "Yes"}, {"label": "No"}}})
	change(owner, "", "decision.delete", M{"id": rw.id("decision removed")})
	do("decision OPS removed", "decision.open", M{"task": "OPS-2", "question": "Also by mistake?", "options": []M{{"label": "Yes"}, {"label": "No"}}})
	change(owner, "", "decision.delete", M{"id": rw.id("decision OPS removed")})
	do("comment SVA-1 owner", "comment.create", M{"task": "SVA-1", "body": "@bea no rings please."})
	as(rw.artist, "comment SVA-1 result", "comment.create", M{"task": "SVA-1", "body": "Drew the burst.", "kind": "result",
		"evidence": M{"checked": "at 1x and 2x", "measured": "12 frames", "not_verified": "on a phone"}, "attachments": []M{{"file": file("burst.txt", "a burst"), "role": "after"}}})
	do("comment OPS-1 owner", "comment.create", M{"task": "OPS-1", "body": "@cy check the vault first."})
	as(rw.ops, "comment OPS-1 ops", "comment.create", M{"task": "OPS-1", "body": "Rotated the first ten.", "decision": rw.id("decision OPS-1 vault"), "option": option("OPS-1", "decision OPS-1 vault", 1)})
	do("comment removed", "comment.create", M{"task": "SVA-1", "body": "Said by mistake."})
	change(owner, "", "comment.delete", M{"id": rw.id("comment removed")})
	do("attachment SVA-1", "attachment.add", M{"task": "SVA-1", "file": file("notes.txt", "notes on the boss"), "caption": "the notes"})
	do("attachment OPS-1", "attachment.add", M{"task": "OPS-1", "file": file("vault.txt", "the vault's layout")})
	do("attachment option", "attachment.add", M{"decision": rw.id("decision SVA-1 explosion"), "option": option("SVA-1", "decision SVA-1 explosion", 1), "file": file("ring.txt", "a ring")})
	do("attachment OPS decision", "attachment.add", M{"decision": rw.id("decision OPS-1 window"), "file": file("nights.txt", "the nights")})
	do("attachment removed", "attachment.add", M{"task": "SVA-1", "file": file("gone.txt", "taken off")})
	change(owner, "", "attachment.remove", M{"id": rw.id("attachment removed")})
	do("attachment OPS removed", "attachment.add", M{"task": "OPS-1", "file": file("ops-gone.txt", "taken off too")})
	change(owner, "", "attachment.remove", M{"id": rw.id("attachment OPS removed")})
	file("loose.txt", "attached to nothing")

	// Pages: shared, private, private and shared with one person, tied to
	// a project, a database with rows in each project, generated ones, an
	// agent's memory, archived and in the trash.
	do("doc Handbook", "doc.create", M{"title": "Handbook", "markdown": "# Handbook\n\nHow we work. See OPS-5.\n"})
	do("doc Release notes", "doc.create", M{"parent": rw.id("doc Handbook"), "title": "Release notes", "markdown": "v0.1\n\n- a boss\n- a song\n"})
	do("doc Salary notes", "doc.create", M{"title": "Salary notes", "private": true, "markdown": "confidential, about SVA-5"})
	do("doc For Bea", "doc.create", M{"title": "For Bea", "private": true, "shared_with": []string{"@bea"}, "markdown": "between us, about SVA-2"})
	made("doc Bea's own", change(bea, "", "doc.create", M{"title": "Bea's own", "private": true, "markdown": "mine"}))
	do("doc SVA design", "doc.create", M{"title": "SVA design", "project": "SVA", "markdown": "The boss has four phases.\n"})
	do("doc SVA sub-page", "doc.create", M{"parent": rw.id("doc SVA design"), "title": "Phase one", "markdown": "It walks.\n"})
	do("doc OPS runbook", "doc.create", M{"title": "OPS runbook", "project": "OPS", "markdown": "Rotate, then restart. The vault is in the cellar. Like SVA-6.\n"})
	do("doc OPS sub-page", "doc.create", M{"parent": rw.id("doc OPS runbook"), "title": "Restarting", "markdown": "Slowly.\n"})
	do("doc OPS private", "doc.create", M{"title": "OPS secrets", "project": "OPS", "private": true, "shared_with": []string{"@bea"}, "markdown": "in OPS, shared with Bea"})
	do("doc Sprites", "doc.create", M{"title": "Sprites", "kind": "database", "project": "SVA"})
	do("property State", "property.create", M{"database": rw.id("doc Sprites"), "name": "State", "type": "select"})
	do("property Frames", "property.create", M{"database": rw.id("doc Sprites"), "name": "Frames", "type": "number"})
	do("dbview drawn", "dbview.create", M{"database": rw.id("doc Sprites"), "name": "Drawn", "type": "table"})
	do("row Boss idle", "doc.create", M{"parent": rw.id("doc Sprites"), "title": "Boss idle", "props": M{"State": "drawn", "Frames": 8}})
	do("row Boss attack", "doc.create", M{"parent": rw.id("doc Sprites"), "title": "Boss attack", "props": M{"State": "todo", "Frames": 12}, "markdown": "Wind up, then strike.\n"})
	do("row removed", "doc.create", M{"parent": rw.id("doc Sprites"), "title": "Boss removed", "props": M{"State": "todo"}})
	change(owner, "", "doc.delete", M{"id": rw.id("row removed")})
	do("doc Servers", "doc.create", M{"title": "Servers", "kind": "database", "project": "OPS"})
	do("property Rack", "property.create", M{"database": rw.id("doc Servers"), "name": "Rack", "type": "text"})
	do("row cellar", "doc.create", M{"parent": rw.id("doc Servers"), "title": "cellar-1", "props": M{"Rack": "A"}})
	do("doc Decision log", "doc.create", M{"title": "Decision log", "generated": "decision_log"})
	do("doc Open questions", "doc.create", M{"title": "Open questions", "generated": "open_questions", "project": "OPS"})
	do("doc Changelog", "doc.create", M{"title": "Changelog", "generated": "changelog", "project": "SVA"})
	do("doc archived", "doc.create", M{"title": "Archived page", "markdown": "kept, out of the way"})
	change(owner, "", "doc.update", M{"id": rw.id("doc archived"), "archived": true})
	do("doc removed", "doc.create", M{"title": "Removed page", "markdown": "in the trash"})
	change(owner, "", "doc.delete", M{"id": rw.id("doc removed")})
	do("doc OPS removed", "doc.create", M{"title": "Removed OPS page", "project": "OPS", "markdown": "in the trash too"})
	change(owner, "", "doc.delete", M{"id": rw.id("doc OPS removed")})
	change(owner, "", "doc.snapshot", M{"doc": rw.id("doc Handbook"), "label": "first"})
	var saved struct{ Versions []struct{ ID string } }
	s.call(t, owner, "", "GET", w+"/docs/"+rw.id("doc Handbook")+"/versions", nil, 200, &saved)
	rw.ids["version Handbook"] = saved.Versions[0].ID
	rw.n.name(saved.Versions[0].ID, "version Handbook")
	change(owner, "", "doc.write", M{"doc": rw.id("doc Handbook"), "markdown": "# Handbook\n\nHow we work now. See OPS-5.\n"})
	do("attachment Handbook", "attachment.add", M{"doc": rw.id("doc Handbook"), "file": file("handbook.txt", "the handbook's file")})
	do("attachment OPS runbook", "attachment.add", M{"doc": rw.id("doc OPS runbook"), "file": file("runbook.txt", "the runbook's file")})
	do("attachment Salary", "attachment.add", M{"doc": rw.id("doc Salary notes"), "file": file("salaries.txt", "who earns what")})
	do("comment Handbook", "comment.create", M{"doc": rw.id("doc Handbook"), "body": "Is this still how we work?"})
	do("comment OPS runbook", "comment.create", M{"doc": rw.id("doc OPS runbook"), "body": "The cellar floods."})
	s.call(t, nil, rw.artist, "POST", w+"/memory", M{"title": "Palette", "markdown": "Reds and golds."}, 201, nil)
	s.call(t, nil, rw.ops, "POST", w+"/memory", M{"title": "Vault", "markdown": "Third shelf."}, 201, nil)
	// A page made private after it had a sub-page, and one under that: they
	// are private with it.
	do("doc Plans", "doc.create", M{"title": "Plans", "markdown": "Where we go next.\n"})
	do("doc Plans sub-page", "doc.create", M{"parent": rw.id("doc Plans"), "title": "Quarter one", "markdown": "Ship the boss. See SVA-1.\n"})
	do("doc Plans sub-sub-page", "doc.create", M{"parent": rw.id("doc Plans sub-page"), "title": "Week one", "markdown": "Draw phase one, as the [[Handbook]] says.\n"})
	do("comment Week one", "comment.create", M{"doc": rw.id("doc Plans sub-sub-page"), "body": "Phase one first."})
	do("attachment Week one", "attachment.add", M{"doc": rw.id("doc Plans sub-sub-page"), "file": file("week.txt", "the week's plan")})
	change(owner, "", "doc.update", M{"id": rw.id("doc Plans"), "private": true})

	// Pages kept in a git repository.
	repo := newSyncedRepo(t, s, map[string]string{"docs/GUIDE.md": "# Style guide\n\nPixels, not vectors.\n"})
	rw.n.replacePath(repo.origin, "<repository>")
	repo.src = do("source Game docs", "source.create", M{"title": "Game docs", "repo": repo.origin, "subdir": "docs"})
	if res := repo.sync(); res.PagesCreated != 1 {
		t.Fatalf("the first sync: %+v", res)
	}
	rw.ids["doc mirrored"] = s.pageID(t, "Style guide")
	rw.n.name(rw.ids["doc mirrored"], "doc mirrored")

	// Saved views: shared, the owner's own, another member's own, tied to
	// a project, one that names a label since deleted, and one deleted.
	do("view Art bugs", "view.create", M{"name": "Art bugs", "project": "SVA", "query": M{"label": []string{"art"}, "open": true}})
	do("view Mine", "view.create", M{"name": "Mine", "shared": false, "query": M{"assignee": []string{"me"}}})
	made("view Bea's", change(bea, "", "view.create", M{"name": "Bea's", "shared": false, "query": M{"waiting_on": "me"}}))
	do("view Ops infra", "view.create", M{"name": "Ops infra", "project": "OPS", "query": M{"label": []string{"infra"}}, "layout": "board"})
	do("view Stale", "view.create", M{"name": "Stale", "query": M{"label": []string{"temp"}, "status": []string{"todo"}}})
	change(owner, "", "label.delete", M{"id": rw.id("label temp")})
	do("view removed", "view.create", M{"name": "Removed view", "query": M{"open": true}})
	change(owner, "", "view.delete", M{"id": rw.id("view removed")})

	// Agents at work: sessions, resources and who holds them, watchers.
	do("resource gpu", "resource.create", M{"name": "gpu", "description": "the one render machine"})
	do("resource staging", "resource.create", M{"name": "staging"})
	do("resource gone", "resource.create", M{"name": "old-box"})
	change(owner, "", "resource.delete", M{"id": rw.id("resource gone")})
	// Every hold the recording takes lasts a day, so that none runs out
	// while the reads are made, however slow the machine.
	as(rw.artist, "claim gpu artist", "resource.acquire", M{"resource": "gpu", "task": "SVA-1", "note": "rendering the boss", "minutes": 24 * 60})
	as(rw.ops, "claim staging ops", "resource.acquire", M{"resource": "staging", "task": "OPS-1", "minutes": 24 * 60})
	as(rw.ops, "claim gpu ops", "resource.acquire", M{"resource": "gpu", "task": "OPS-2", "note": "after the artist", "minutes": 24 * 60})
	as(rw.artist, "session artist", "session.start", M{"task": "SVA-1", "title": "Drawing the boss", "instructions": "four phases"})
	change(nil, rw.artist, "session.update", M{"id": rw.id("session artist"), "summary": "two phases drawn",
		"add_steps": []M{{"text": "sketched phase one"}}})
	as(rw.ops, "session ops", "session.start", M{"task": "OPS-1", "title": "Rotating keys"})
	as(rw.ops, "session ops ended", "session.start", M{"task": "OPS-2", "title": "Checking backups"})
	change(nil, rw.ops, "session.update", M{"id": rw.id("session ops ended"), "state": "done", "summary": "all there"})
	as(rw.ops, "session no task", "session.start", M{"title": "Looking around"})
	// Quadit's runner runs @ops for OPS on a machine, and works on OPS-2.
	runner := "machine_id=3f9c0a7d5e21b864&machine_name=Ops+box&folder=~/ops&program=codex&program_version=0.170.0"
	var held struct{ Lease string }
	s.call(t, nil, rw.ops, "GET", w+"/listen?project=OPS&by=Quadit%27s+runner&"+runner, nil, 200, &held)
	// It holds the lease all through the reads, however slow the machine:
	// the lease, and when its member listens until, which the hold wrote
	// ninety seconds ahead, are put a day ahead together.
	ahead := time.Now().Add(24 * time.Hour).UnixMilli()
	var ops core.Listener
	if err := st.Get(context.Background(), &ops, store.Eq("lease", held.Lease)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Update(context.Background(), "listeners", map[string]any{"lease_until": ahead}, store.Eq("lease", held.Lease)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Update(context.Background(), "members", map[string]any{"listening_until": ahead}, store.Eq("user_id", ops.AgentID)); err != nil {
		t.Fatal(err)
	}
	as(rw.ops, "run ops", "session.start", M{"task": "OPS-2", "state": "waiting", "program": "codex", "machine_id": "3f9c0a7d5e21b864", "machine_name": "Ops box",
		"folder": "~/ops", "lease": held.Lease, "item_seq": 1, "instructions": "#1 assigned"})
	change(nil, rw.artist, "task.take", M{"id": "SVA-1", "minutes": 24 * 60})
	change(owner, "", "watch.set", M{"subject": "OPS-1"})
	change(bea, "", "watch.set", M{"subject": "SVA-1"})
	change(owner, "", "watch.set", M{"subject": "OPS-2", "user": "@cy"})

	// What only admins list: rules, webhooks, integrations, secrets.
	rw.hook = newReceiver(t, "")
	rw.n.replace(rw.hook.srv.URL, "http://receiver.test")
	do("rule notify", "rule.create", M{"name": "tell the owner", "active": false, "match": M{"event_types": []string{"task.created"}, "project_id": rw.id("project OPS")},
		"action": M{"kind": "notify", "user_id": s.ownerID(t)}})
	do("rule gone", "rule.create", M{"name": "gone", "active": false, "match": M{"event_types": []string{"task.created"}}, "action": M{"kind": "notify", "user_id": s.ownerID(t)}})
	change(owner, "", "rule.delete", M{"id": rw.id("rule gone")})
	do("webhook OPS", "webhook.create", M{"name": "ops events", "url": rw.hook.srv.URL + "/ops", "event_types": []string{"never.matches"}, "project": "OPS"})
	do("webhook gone", "webhook.create", M{"name": "gone", "url": rw.hook.srv.URL + "/gone", "event_types": []string{"never.matches"}})
	change(owner, "", "webhook.delete", M{"id": rw.id("webhook gone")})
	// The integrations are off, so that nothing in the background tries to
	// reach GitHub for them while the reads are recorded.
	do("integration github", "integration.create", M{"kind": "github", "name": "sva on github", "project": "SVA", "secret": "ghp_secret", "active": false})
	do("integration OPS", "integration.create", M{"kind": "github", "name": "ops on github", "project": "OPS", "secret": "ghp_other", "active": false})
	do("secret DEPLOY_KEY", "secret.set", M{"name": "DEPLOY_KEY", "value": "s3cret", "description": "for the staging box", "agents": []string{"@ops"}})

	// What the dispatcher makes of the feed. A watched view: a task that
	// comes into it is news for whoever watches it and may see it.
	change(owner, "", "watch.set", M{"type": "view", "subject": rw.id("view Art bugs")})
	change(bea, "", "watch.set", M{"type": "view", "subject": rw.id("view Art bugs")})
	// A view of a project Bea may not read is not hers to follow; a page
	// of hers is.
	s.call(t, bea, "", "POST", w+"/changes", M{"id": id.New(), "type": "watch.set", "args": M{"type": "view", "subject": rw.id("view Ops infra")}}, 403, nil)
	change(bea, "", "watch.set", M{"type": "doc", "subject": rw.id("doc SVA design")})
	change(owner, "", "watch.set", M{"type": "view", "subject": rw.id("view Ops infra"), "user": "@cy"})
	rw.settle()
	change(nil, rw.artist, "task.update", M{"id": "SVA-6", "add_labels": []string{"art"}})
	rw.settle()
	change(nil, rw.ops, "task.update", M{"id": "OPS-1", "priority": 2})
	rw.settle()
	// A webhook: what it is sent for one comment.
	do("webhook comments", "webhook.create", M{"name": "comments", "url": rw.hook.srv.URL + "/comments", "event_types": []string{"comment.created"}})
	as(rw.artist, "comment SVA-1 for the webhook", "comment.create", M{"task": "SVA-1", "body": "Phase three is drawn."})
	rw.settle()
	rw.waitFor("the webhook's delivery", func() bool {
		var out struct{ Deliveries []core.WebhookDelivery }
		s.call(t, owner, "", "GET", w+"/list/deliveries", nil, 200, &out)
		return len(out.Deliveries) == 1 && out.Deliveries[0].State == core.DeliveryOK
	})
	// The last event: one every caller may see, so a reader of the live
	// stream knows where to stop.
	do("label last", "label.create", M{"name": "last"})
	rw.settle()
	return rw
}

// invited makes a member signed in on a browser of their own.
func (rw *richWorkspace) invited(name, email string) (*http.Client, string) {
	rw.t.Helper()
	var inv struct{ Link string }
	rw.s.call(rw.t, rw.s.owner, "", "POST", w+"/invites", M{}, 201, &inv)
	b := browser()
	var joined struct {
		User struct{ ID string } `json:"user"`
	}
	rw.s.call(rw.t, b, "", "POST", "/api/v1/auth/invite/"+inv.Link[strings.LastIndex(inv.Link, "/")+1:], M{"name": name, "email": email, "password": "another-long-password"}, 200, &joined)
	return b, joined.User.ID
}

func (rw *richWorkspace) waitFor(what string, done func() bool) {
	rw.t.Helper()
	for deadline := time.Now().Add(20 * time.Second); !done(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			rw.t.Fatalf("waited too long for %s", what)
		}
	}
}

// settle waits until the dispatcher has handled every event there is, and
// what it wrote in turn.
func (rw *richWorkspace) settle() {
	rw.t.Helper()
	rw.waitFor("the dispatcher", func() bool {
		var wss []core.Workspace
		if err := rw.st.List(context.Background(), &wss, store.Where(store.Eq("slug", "games"))); err != nil || len(wss) != 1 {
			rw.t.Fatalf("reading the workspace: %v", err)
		}
		return wss[0].DispatchedSeq == wss[0].Seq
	})
}

// read is one GET the recording makes.
type read struct {
	// route is the pattern the server registers it under, with the
	// workspace as {ws}.
	route string
	// path is what is asked, after the workspace's address when the route is
	// inside one.
	path string
	// statusOnly records the status alone: the body is not the same twice
	// (counters, sizes on disk, a page of HTML).
	statusOnly bool
}

// reads lists what is asked of every GET route, in the order it is asked.
// A route in notRecorded is not asked, for the reason there.
func (rw *richWorkspace) reads() []read {
	id := rw.id
	inWS := func(route string, paths ...string) []read {
		var out []read
		for _, p := range paths {
			out = append(out, read{route: "GET /api/v1/w/{ws}" + route, path: w + p})
		}
		return out
	}
	var all []read
	add := func(rs ...read) { all = append(all, rs...) }

	// Outside any workspace.
	add(read{route: "GET /healthz", path: "/healthz"}, read{route: "GET /readyz", path: "/readyz"},
		read{route: "GET /metrics", path: "/metrics", statusOnly: true},
		read{route: "GET /api/v1/auth/config", path: "/api/v1/auth/config"},
		read{route: "GET /api/v1/auth/me", path: "/api/v1/auth/me"},
		read{route: "GET /api/v1/auth/sessions", path: "/api/v1/auth/sessions"},
		read{route: "GET /api/v1/auth/passkeys", path: "/api/v1/auth/passkeys"},
		read{route: "GET /api/v1/auth/second-step", path: "/api/v1/auth/second-step"},
		read{route: "GET /api/v1/auth/identities", path: "/api/v1/auth/identities"},
		read{route: "GET /api/v1/auth/invite/{token}", path: "/api/v1/auth/invite/not-a-token"},
		read{route: "GET /api/v1/auth/oauth/{provider}/start", path: "/api/v1/auth/oauth/github/start", statusOnly: true},
		read{route: "GET /api/v1/auth/oauth/{provider}/callback", path: "/api/v1/auth/oauth/github/callback", statusOnly: true},
		read{route: "GET /api/v1/auth/render-session", path: "/api/v1/auth/render-session?token=nope", statusOnly: true},
		read{route: "GET /api/v1/changes", path: "/api/v1/changes?format=text"},
		read{route: "GET /api/v1/version", path: "/api/v1/version"},
		read{route: "GET /api/v1/events/types", path: "/api/v1/events/types"},
		read{route: "GET /api/v1/openapi.json", path: "/api/v1/openapi.json", statusOnly: true},
		read{route: "GET /api/v1/push/key", path: "/api/v1/push/key", statusOnly: true},
		read{route: "GET /.well-known/oauth-protected-resource", path: "/.well-known/oauth-protected-resource"},
		read{route: "GET /.well-known/oauth-protected-resource/mcp", path: "/.well-known/oauth-protected-resource/mcp"},
		read{route: "GET /.well-known/oauth-authorization-server", path: "/.well-known/oauth-authorization-server"},
		read{route: "GET /oauth/authorize", path: "/oauth/authorize", statusOnly: true},
		read{route: "GET /desktop/finish", path: "/desktop/finish?code=nope&verifier=nope", statusOnly: true},
		read{route: "GET /mcp", path: "/mcp", statusOnly: true},
		read{route: "GET /api/v1/admin/settings", path: "/api/v1/admin/settings", statusOnly: true},
		read{route: "GET /api/v1/admin/audit", path: "/api/v1/admin/audit", statusOnly: true},
		read{route: "GET /api/v1/admin/users", path: "/api/v1/admin/users"},
		read{route: "GET /api/v1/admin/workspaces", path: "/api/v1/admin/workspaces", statusOnly: true},
		read{route: "GET /api/v1/admin/health", path: "/api/v1/admin/health", statusOnly: true},
		read{route: "GET /api/v1/admin/backups", path: "/api/v1/admin/backups"},
		read{route: "GET /api/v1/admin/backups/{id}/download", path: "/api/v1/admin/backups/" + id("project SVA") + "/download"},
	)

	// Orientation.
	add(inWS("/me", "/me", "/me?format=text")...)
	add(inWS("/my-work", "/my-work", "/my-work?format=text")...)
	add(inWS("/inbox", "/inbox", "/inbox?all=1", "/inbox?format=text&all=1", "/inbox?since=0&limit=2")...)
	add(inWS("/projects/{key}/layout", "/projects/SVA/layout", "/projects/SVA/layout?format=text", "/projects/OPS/layout", "/projects/OPS/layout?format=text",
		"/projects/ARC/layout", "/projects/DEL/layout", "/projects/NOPE/layout")...)
	add(inWS("/cursors/{name}", "/cursors/main")...)

	// Tasks: the list with each filter, one task in each form, the context pack.
	add(inWS("/tasks", "/tasks", "/tasks?format=text", "/tasks?raw=1", "/tasks?count=1", "/tasks?fields=key,title,project,description,id",
		"/tasks?project=SVA", "/tasks?project=OPS", "/tasks?project=OPS&format=text", "/tasks?project=SVA,OPS", "/tasks?project=ARC", "/tasks?project=DEL", "/tasks?project=NOPE",
		"/tasks?assignee=me", "/tasks?assignee=@artist,none", "/tasks?assignee=@nobody", "/tasks?creator=me", "/tasks?status=todo", "/tasks?status=Review", "/tasks?status=nope",
		"/tasks?category=started", "/tasks?category=nope", "/tasks?open=0", "/tasks?open=1", "/tasks?waiting_on=me", "/tasks?waiting_on=@bea", "/tasks?waiting_on=outside", "/tasks?waiting_on=none",
		"/tasks?held_by=@artist", "/tasks?label=art", "/tasks?label=infra", "/tasks?label=bug", "/tasks?label=nope", "/tasks?epic=Boss+fight", "/tasks?epic=Hardening", "/tasks?epic=none", "/tasks?epic=nope",
		"/tasks?cycle=current", "/tasks?cycle=next", "/tasks?cycle=none", "/tasks?cycle=1", "/tasks?cycle=99", "/tasks?milestone=Alpha", "/tasks?milestone=Audit", "/tasks?milestone=nope",
		"/tasks?priority=high", "/tasks?priority=1,2", "/tasks?priority=nope", "/tasks?due_before="+dayOffset(30), "/tasks?due_after="+dayOffset(30),
		"/tasks?mentions=@bea", "/tasks?mentions=me", "/tasks?watching=1", "/tasks?has_open_decision=1", "/tasks?asked=me", "/tasks?asked=@cy",
		"/tasks?changed_since=1", "/tasks?since=100", "/tasks?updated_since=100", "/tasks?parent=SVA-1", "/tasks?parent=OPS-1", "/tasks?top_level=1", "/tasks?q=boss", "/tasks?q=keys",
		"/tasks?keys=SVA-1,OPS-1,sva-2", "/tasks?trash=1", "/tasks?archived=1", "/tasks?sort=key", "/tasks?sort=-updated", "/tasks?sort=priority&limit=3", "/tasks?sort=nope",
		"/tasks?limit=2&offset=2", "/tasks?nope=1",
		"/tasks?view=art-bugs", "/tasks?view=Art+bugs", "/tasks?view="+id("view Art bugs"), "/tasks?view=mine", "/tasks?view=bea-s", "/tasks?view=ops-infra", "/tasks?view=ops-infra&format=text",
		"/tasks?view=stale", "/tasks?view=stale&format=text", "/tasks?view=stale&count=1", "/tasks?view=removed-view", "/tasks?view=nope", "/tasks?view=art-bugs&assignee=me")...)
	for _, key := range []string{"SVA-1", "OPS-1", "SVA-2", "OPS-2", "SVA-4", "OPS-3", "SVA-5", "OPS-4", "ARC-1", "DEL-1"} {
		add(inWS("/tasks/{ref}", "/tasks/"+key, "/tasks/"+key+"?format=text", "/tasks/"+key+"?raw=1")...)
	}
	add(inWS("/tasks/{ref}", "/tasks/"+id("task SVA-1"), "/tasks/"+id("task OPS-1"), "/tasks/SVA-1?since=150", "/tasks/OPS-1?since=0&compact=1", "/tasks/SVA-1?since=0&format=text",
		"/tasks/SVA-1?max_chars=10", "/tasks/SVA-1?full=1&format=text", "/tasks/NOPE-1", "/tasks/SVA-999", "/tasks/nonsense")...)
	add(inWS("/tasks/{ref}/context", "/tasks/SVA-1/context", "/tasks/SVA-1/context?format=text", "/tasks/SVA-2/context", "/tasks/SVA-2/context?format=text",
		"/tasks/OPS-2/context", "/tasks/OPS-2/context?format=text", "/tasks/SVA-3/context", "/tasks/SVA-5/context", "/tasks/SVA-6/context", "/tasks/SVA-6/context?format=text",
		"/tasks/OPS-5/context", "/tasks/SVA-999/context")...)

	// Decisions and search.
	add(inWS("/decisions", "/decisions", "/decisions?format=text", "/decisions?state=all", "/decisions?state=open", "/decisions?state=picked", "/decisions?state=nope",
		"/decisions?trash=1", "/decisions?project=SVA", "/decisions?project=OPS", "/decisions?project=NOPE", "/decisions?asked=me", "/decisions?asked=@cy", "/decisions?q=vault",
		"/decisions?since=0&state=all", "/decisions?limit=1&offset=1&state=all")...)
	add(inWS("/search", "/search?q=boss", "/search?q=boss&format=text", "/search?q=keys", "/search?q=vault", "/search?q=vault&format=text", "/search?q=phases", "/search?q=confidential",
		"/search?q=between", "/search?q=cellar", "/search?q=rotate", "/search?q=boss&kind=task", "/search?q=boss&kind=doc", "/search?q=vault&kind=comment", "/search?q=hardening&kind=epic",
		"/search?q=boss&limit=1", "/search?q=mistake", "/search?q=trash", "/search?q=", "/search")...)

	// The feed.
	// The feed: whole as rows once, then one line an event for each way of
	// narrowing it.
	add(inWS("/events", "/events?after=0&limit=2000", "/events?after=0&limit=2000&format=text", "/events?after=0&limit=2000&compact=1", "/events?after=0&limit=5",
		"/events?after=0&others=1&limit=20&compact=1", "/events?after=0&inbox=1", "/events?after=0&inbox=1&format=text", "/events?after=0&types=comment.created,decision.opened&compact=1",
		"/events?after=0&task=SVA-1&compact=1", "/events?after=0&task=OPS-1&compact=1", "/events?after=0&doc="+id("doc Handbook"), "/events?after=0&doc="+id("doc OPS runbook"),
		"/events?after=0&doc="+id("doc Salary notes"), "/events?after=0&mine=1&compact=1", "/events?after=0&project=SVA&limit=2000&compact=1", "/events?after=0&project=OPS&limit=2000&compact=1",
		"/events?after=0&label=art&compact=1", "/events?after=0&assignee=me&compact=1", "/events?after=0&view=ops-infra&compact=1", "/events?after=0&view=stale&compact=1",
		"/events?cursor=main&compact=1", "/events?after=99999", "/events?after=0&nope=1")...)

	// The starting copy and each kind of row as stored.
	add(inWS("/bootstrap", "/bootstrap", "/bootstrap?part=open", "/bootstrap?part=rest", "/bootstrap?part=nope", "/bootstrap?fields=name,title", "/bootstrap?since=200")...)
	for _, name := range collectionNames {
		add(inWS("/list/{collection}", "/list/"+name, "/list/"+name+"?format=text", "/list/"+name+"?trash=1")...)
	}
	for _, name := range []string{"statuses", "labels", "epics", "cycles", "templates", "preferences", "webhooks", "integrations", "views", "members"} {
		add(inWS("/list/{collection}", "/list/"+name+"?project=SVA", "/list/"+name+"?project=OPS")...)
	}
	for _, name := range []string{"claims", "sessions", "relations", "attachments", "links", "labels"} {
		add(inWS("/list/{collection}", "/list/"+name+"?task=SVA-1", "/list/"+name+"?task=OPS-1")...)
	}
	add(inWS("/list/{collection}", "/list/nope", "/list/milestones?epic="+id("epic Boss fight"), "/list/milestones?epic="+id("epic Hardening"), "/list/milestones?epic="+id("epic Scrapped"),
		"/list/labels?limit=2&offset=1", "/list/labels?since=10", "/list/labels?since=10&format=text", "/list/labels?fields=name", "/list/deliveries?webhook="+id("webhook comments"),
		"/list/sessions?agent="+id("@ops"), "/list/claims?project=NOPE", "/list/links?task=NOPE-1")...)

	// Pages.
	add(inWS("/docs", "/docs", "/docs?format=text", "/docs?trash=1", "/docs?project=SVA", "/docs?project=OPS", "/docs?project=OPS&format=text", "/docs?project=NOPE",
		"/docs?since=0&format=text", "/docs?since=99999&format=text")...)
	for _, name := range []string{"doc Handbook", "doc Release notes", "doc Salary notes", "doc For Bea", "doc Bea's own", "doc SVA design", "doc SVA sub-page", "doc OPS runbook",
		"doc OPS sub-page", "doc OPS private", "doc Sprites", "row Boss attack", "doc Servers", "row cellar", "doc Decision log", "doc Open questions", "doc Changelog",
		"doc archived", "doc removed", "doc OPS removed", "doc mirrored", "doc Plans", "doc Plans sub-page", "doc Plans sub-sub-page"} {
		add(inWS("/docs/{id}", "/docs/"+id(name), "/docs/"+id(name)+"?format=md", "/docs/"+id(name)+"?format=text")...)
		add(inWS("/docs/{id}/versions", "/docs/"+id(name)+"/versions")...)
	}
	for _, name := range []string{"doc Sprites", "doc Servers", "doc Handbook", "doc Bea's own", "doc removed"} {
		add(inWS("/docs/{id}/rows", "/docs/"+id(name)+"/rows", "/docs/"+id(name)+"/rows?format=text")...)
	}
	for _, name := range []string{"doc Handbook", "doc OPS runbook", "doc Plans sub-sub-page", "doc Salary notes", "doc Bea's own"} {
		add(inWS("/docs/{id}/comments", "/docs/"+id(name)+"/comments", "/docs/"+id(name)+"/comments?format=text")...)
	}
	add(inWS("/docs/{id}", "/docs/"+id("project SVA"), "/docs/"+id("doc Handbook")+"?max_chars=10&format=text", "/docs/"+id("doc Handbook")+"?format=text&comments=0",
		"/docs/"+id("doc Handbook")+"?format=md&comments=1")...)
	add(inWS("/docs/{id}/versions/{version}", "/docs/"+id("doc Handbook")+"/versions/"+id("version Handbook"), "/docs/"+id("doc Handbook")+"/versions/"+id("version Handbook")+"?format=md",
		"/docs/"+id("doc OPS runbook")+"/versions/"+id("version Handbook"), "/docs/"+id("doc Handbook")+"/versions/"+id("project SVA"))...)
	add(inWS("/docs/{id}/rows", "/docs/"+id("doc Sprites")+"/rows?raw=1", "/docs/"+id("doc Sprites")+"/rows?view=Drawn", "/docs/"+id("doc Sprites")+"/rows?filter=State:drawn",
		"/docs/"+id("doc Sprites")+"/rows?sort=-Frames", "/docs/"+id("doc Sprites")+"/rows?view=nope", "/docs/"+id("doc Sprites")+"/rows?filter=Nope:1")...)
	add(inWS("/memory", "/memory", "/memory?format=text", "/memory?agent=@artist", "/memory?agent=@artist&format=text", "/memory?agent=@ops", "/memory?agent=@bea", "/memory?agent=@nobody")...)
	add(inWS("/sources", "/sources")...)

	// The dashboard, a cycle's chart and the agents.
	add(inWS("/dashboard", "/dashboard", "/dashboard?format=text", "/dashboard?project=SVA", "/dashboard?project=SVA&format=text", "/dashboard?project=OPS",
		"/dashboard?project=OPS&format=text", "/dashboard?project=ARC", "/dashboard?project=NOPE")...)
	add(inWS("/cycles/{id}/chart", "/cycles/"+id("cycle SVA now")+"/chart", "/cycles/"+id("cycle OPS now")+"/chart", "/cycles/"+id("cycle SVA gone")+"/chart", "/cycles/"+id("project SVA")+"/chart")...)
	add(inWS("/agents", "/agents", "/agents?format=text")...)
	add(inWS("/agents/connection", "/agents/connection")...)
	add(inWS("/listening", "/listening")...)
	add(inWS("/listening/{key}/waiting", "/listening/OPS/waiting")...)
	add(inWS("/tasks/{ref}/run-outlook", "/tasks/OPS-1/run-outlook?agents=@ops,@artist,@nobody&cause=comment", "/tasks/OPS-2/run-outlook?agents=@ops&cause=assign",
		"/tasks/OPS-1/run-outlook?agents=@ops&cause=assign", "/tasks/SVA-1/run-outlook?agents=@ops,@artist&cause=comment", "/tasks/OPS-1/run-outlook?agents=@ops&cause=nope",
		"/tasks/OPS-1/run-outlook?cause=comment", "/tasks/NOPE-1/run-outlook?agents=@ops&cause=comment")...)

	// Files, tokens, secrets and the rest.
	for _, name := range []string{"file notes.txt", "file vault.txt", "file ring.txt", "file nights.txt", "file gone.txt", "file ops-gone.txt", "file burst.txt", "file loose.txt",
		"file handbook.txt", "file runbook.txt", "file salaries.txt", "file week.txt"} {
		add(inWS("/files/{id}", "/files/"+id(name))...)
		add(read{route: "GET /f/{id}/{name...}", path: "/f/" + id(name) + "/" + strings.TrimPrefix(name, "file ")})
	}
	add(read{route: "GET /f/{id}/{name...}", path: "/f/" + id("file notes.txt") + "/preview"})
	add(inWS("/files/{id}", "/files/"+id("project SVA"))...)
	add(read{route: "GET /f/{id}/{name...}", path: "/f/" + id("project SVA") + "/x.txt"})
	add(inWS("/tokens", "/tokens")...)
	add(inWS("/connect-codes/{id}", "/connect-codes/"+id("project SVA"))...)
	add(inWS("/secrets", "/secrets", "/secrets?format=text")...)
	add(inWS("/invites", "/invites")...)
	add(inWS("/integrations/{id}/webhook", "/integrations/"+id("integration github")+"/webhook", "/integrations/"+id("integration OPS")+"/webhook", "/integrations/"+id("project SVA")+"/webhook")...)
	add(inWS("/audit", "/audit?limit=5", "/audit?action=workspace.exported")...)
	return all
}

// notRecorded are the GET routes the recording does not ask, and why.
var notRecorded = map[string]string{
	"GET /api/v1/w/{ws}/render":        "takes a picture with a browser, which a test run does not have; what it may show is decided by taskByRef and docByID, which the task and page reads record",
	"GET /api/v1/w/{ws}/events/stream": "recorded by its own reader (stream), which stops at the last event instead of waiting",
	"GET /api/v1/w/{ws}/export":        "recorded by its own reader (export), which unpacks the archive",
	"GET /api/v1/w/{ws}/listen":        "takes the listener's lease, whose id is new each time; the items it answers are the caller's inbox in the feed, recorded by /events?inbox=1, and TestTheListener checks it",
	"GET /licenses":                    "the same text for everyone, signed in or not, and checked by TestTheLicensesAreServed",
}

// collectionNames are the lists /list/{collection} has, in the order they
// are asked; everyGetRouteWasCalled holds them to the ones the server has.
var collectionNames = []string{"members", "projects", "statuses", "labels", "epics", "milestones", "cycles", "templates", "preferences", "resources", "secrets", "claims",
	"sessions", "relations", "attachments", "links", "webhooks", "deliveries", "rules", "integrations", "views"}

func dayOffset(n int) string { return time.Now().UTC().AddDate(0, 0, n).Format("2006-01-02") }

// everyGetRouteWasCalled fails when the server registers a GET route the
// recording neither asked nor excused.
func (rw *richWorkspace) everyGetRouteWasCalled() {
	rw.t.Helper()
	n := 0
	for _, route := range rw.s.srv.RoutePatterns() {
		if !strings.HasPrefix(route, "GET ") {
			continue
		}
		n++
		if !rw.called[route] && notRecorded[route] == "" {
			rw.t.Errorf("%s is a read the recording does not ask: add it to reads, or to notRecorded with the reason", route)
		}
	}
	if n < 50 {
		rw.t.Fatalf("found only %d GET routes", n)
	}
	// The lists: a wrong name is answered with the names there are.
	var refusal struct {
		Error struct{ Allowed []string }
	}
	rw.s.call(rw.t, rw.s.owner, "", "GET", w+"/list/nope", nil, 404, &refusal)
	asked := append([]string(nil), collectionNames...)
	sort.Strings(asked)
	if has := refusal.Error.Allowed; strings.Join(has, " ") != strings.Join(asked, " ") {
		rw.t.Errorf("the recording asks the lists %v, and the server has %v: bring collectionNames in line", asked, has)
	}
	for route := range rw.called {
		if notRecorded[route] != "" {
			rw.t.Errorf("%s is both asked and excused", route)
		}
	}
}

// recording is what one caller is answered, as text.
type recording struct {
	rw  *richWorkspace
	who caller
	out strings.Builder
}

// get asks one path as the caller and returns the status and the body.
func (rec *recording) get(path string) (int, http.Header, []byte) {
	rec.rw.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, rec.rw.s.url+path, nil)
	hc := rec.who.hc
	if hc == nil {
		hc = http.DefaultClient
		req.Header.Set("Authorization", "Bearer "+rec.who.token)
	}
	resp, err := hc.Do(req)
	if err != nil {
		rec.rw.t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, raw
}

func (rec *recording) write(path string, status int, body string) {
	fmt.Fprintf(&rec.out, "\n=== GET %s\n%d\n%s", rec.rw.n.text(path), status, body)
	if !strings.HasSuffix(body, "\n") {
		rec.out.WriteString("\n")
	}
}

// everyRead asks everything, in order.
func (rec *recording) everyRead() {
	rw := rec.rw
	for _, r := range rw.reads() {
		rw.called[r.route] = true
		status, _, raw := rec.get(r.path)
		body := ""
		if !r.statusOnly {
			body = rw.n.body(raw)
		}
		rec.write(r.path, status, body)
	}
	rec.taskPages()
	rec.stream()
	rec.export()
	rec.outside()
}

// taskPages walks the task list by cursor, two at a time.
func (rec *recording) taskPages() {
	path := w + "/tasks?sort=key&limit=4"
	for page := 1; page <= 6; page++ {
		status, _, raw := rec.get(path)
		rec.write(fmt.Sprintf("%s/tasks?sort=key&limit=4 (page %d by cursor)", w, page), status, rec.rw.n.body(raw))
		var out struct {
			Next string `json:"next_cursor"`
		}
		if json.Unmarshal(raw, &out) != nil || out.Next == "" {
			return
		}
		path = w + "/tasks?sort=key&limit=4&cursor=" + out.Next
	}
	rec.rw.t.Fatal("the task list did not end")
}

// stream reads the live stream from the start up to the workspace's last
// event, which every caller may see.
func (rec *recording) stream() {
	rw := rec.rw
	var wss []core.Workspace
	if err := rw.st.List(context.Background(), &wss, store.Where(store.Eq("slug", "games"))); err != nil || len(wss) != 1 {
		rw.t.Fatalf("reading the workspace: %v", err)
	}
	var last core.Event
	evs, err := rw.st.In(wss[0].ID).Events(context.Background(), store.EventFilter{Limit: 5000})
	if err != nil {
		rw.t.Fatal(err)
	}
	for _, ev := range evs {
		if ev.Type == "label.created" {
			last = ev
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, rw.s.url+w+"/events/stream?after=0", nil)
	hc := rec.who.hc
	if hc == nil {
		hc = http.DefaultClient
		req.Header.Set("Authorization", "Bearer "+rec.who.token)
	}
	resp, err := hc.Do(req)
	if err != nil {
		rw.t.Fatalf("the live stream: %v", err)
	}
	defer resp.Body.Close()
	var got strings.Builder
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	stop := fmt.Sprintf("id: %d", last.Seq)
	for done := false; sc.Scan(); {
		line := sc.Text()
		got.WriteString(line + "\n")
		if done && line == "" {
			break // the blank line that ends the last event
		}
		done = done || line == stop
	}
	rec.write(w+"/events/stream?after=0 (up to the last label made)", resp.StatusCode, rw.n.stream(got.String()))
}

// export unpacks the archive: the names of its files, and each file of text.
func (rec *recording) export() {
	rw := rec.rw
	status, head, raw := rec.get(w + "/export")
	if status != 200 {
		rec.write(w+"/export", status, rw.n.body(raw))
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		rw.t.Fatalf("the export is not an archive: %v", err)
	}
	var names strings.Builder
	names.WriteString(head.Get("Content-Type") + "\n")
	for _, f := range zr.File {
		fmt.Fprintf(&names, "%s\n", rw.n.text(f.Name))
	}
	rec.write(w+"/export (the archive's files)", status, names.String())
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "files/") && f.Name != "files/NOT-INCLUDED.txt" {
			continue
		}
		rd, err := f.Open()
		if err != nil {
			rw.t.Fatal(err)
		}
		body, _ := io.ReadAll(rd)
		rd.Close()
		rec.write(w+"/export: "+f.Name, status, rw.n.body(body))
	}
}

// outside records what the server sends on its own for what the workspace
// did: the body of the webhook's delivery, as its receiver got it. (What a
// watched view made of a task that came into it is in each caller's inbox
// and feed.)
func (rec *recording) outside() {
	rw := rec.rw
	if rec.who.name != "admin" {
		return
	}
	rw.hook.mu.Lock()
	defer rw.hook.mu.Unlock()
	for i, payload := range rw.hook.got {
		raw, _ := json.Marshal(payload)
		rec.write(fmt.Sprintf("(webhook delivery %d of %d)", i+1, len(rw.hook.got)), 200, rw.n.body(raw))
	}
}

// normaliser makes an answer the same on every run: ids become names or
// numbers in the order they are first seen, times and dates become what
// they are relative to today, and the server's address becomes a fixed one.
type normaliser struct {
	names    map[string]string
	replaces []string
	// paths are this machine's paths that a line of text may show cut
	// short, each with what it becomes (replacePath).
	paths map[string]string
	days  map[string]string
}

func newNormaliser(baseURL string) *normaliser {
	n := &normaliser{names: map[string]string{}, paths: map[string]string{}, days: map[string]string{}}
	n.replace(baseURL, "http://quadit.test")
	n.replace(strings.TrimPrefix(baseURL, "http://"), "quadit.test")
	for offset := -40; offset <= 400; offset++ {
		n.days[dayOffset(offset)] = fmt.Sprintf("<day%+d>", offset)
	}
	return n
}

func (n *normaliser) name(id, name string) { n.names[id] = "<" + name + ">" }

// replace has every from in a text become to. A Windows path's backslashes
// are doubled in JSON: that form is replaced too, and first, so that it is
// found before the plain one could be inside it.
func (n *normaliser) replace(from, to string) {
	if escaped := strings.ReplaceAll(from, `\`, `\\`); escaped != from {
		n.replaces = append(n.replaces, escaped, to)
	}
	n.replaces = append(n.replaces, from, to)
}

// replacePath is replace for a path of this machine. A line of text cuts a
// long one short ("/var/folders/…/T/TestEvery…"), and how much of it is
// left depends on where the machine keeps its temporary files, so the cut
// form becomes the same word: the answer is then the same on every machine.
func (n *normaliser) replacePath(path, to string) {
	n.replace(path, to)
	n.paths[path] = to
}

// windowsTailRE finds the rest of a Windows path after the part replaced
// (<data>\backups, or <data>\\backups in JSON).
var windowsTailRE = regexp.MustCompile(`(<[a-z]+>)((?:\\{1,2}[^"\\\s]+)+)`)

// backslashes is a run of them: a Windows path's one backslash, quoted
// once in a line and again in the JSON that carries the line.
var backslashes = regexp.MustCompile(`\\+`)

// cutShortRE finds what may be a path cut short: from a slash, or a
// Windows drive (its backslashes doubled each time it is quoted), to the
// mark of the cut.
var cutShortRE = regexp.MustCompile(`/[^"\\\s…]*…|[A-Za-z]:\\[^"\s…]*…`)

var (
	uuidRE    = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	rfc3339RE = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)`)
	minuteRE  = regexp.MustCompile(`\d{4}-\d\d-\d\d \d\d:\d\d`)
	shortRE   = regexp.MustCompile(`\b\d\d-\d\d \d\d:\d\d\b`)
	dayRE     = regexp.MustCompile(`\d{4}-\d\d-\d\d`)
	millisRE  = regexp.MustCompile(`\b1[7-9]\d{11}\b`)
	commitRE  = regexp.MustCompile(`\b[0-9a-f]{40}\b`)
	tokenRE   = regexp.MustCompile(`qd_[A-Za-z0-9_-]{8}`)
	cursorRE  = regexp.MustCompile(`cursor=[A-Za-z0-9_-]{20,}`)
	weekRE    = regexp.MustCompile(`\b\d{4}, week \d+\b`)
	isoWeekRE = regexp.MustCompile(`\b\d{4}-W\d\d\b`)
	// A session remembers the address it was started from: the test's client reaches the server over either loopback.
	loopbackRE = regexp.MustCompile(`"ip":\s*"(127\.0\.0\.1|::1)"`)
)

// text makes one piece of text the same on every run.
func (n *normaliser) text(s string) string {
	s = strings.NewReplacer(n.replaces...).Replace(s)
	if filepath.Separator == '\\' {
		// The rest of a path replaced is written as on every other system.
		s = windowsTailRE.ReplaceAllStringFunc(s, func(path string) string {
			return strings.ReplaceAll(strings.ReplaceAll(path, `\\`, `/`), `\`, `/`)
		})
	}
	s = cutShortRE.ReplaceAllStringFunc(s, func(cut string) string {
		for path, to := range n.paths {
			if strings.HasPrefix(path, backslashes.ReplaceAllString(strings.TrimSuffix(cut, "…"), `\`)) {
				return to
			}
		}
		return cut
	})
	s = uuidRE.ReplaceAllStringFunc(s, func(id string) string {
		if _, ok := n.names[id]; !ok {
			n.names[id] = fmt.Sprintf("<id #%d>", len(n.names)+1)
		}
		return n.names[id]
	})
	s = rfc3339RE.ReplaceAllString(s, "<time>")
	s = minuteRE.ReplaceAllString(s, "<minute>")
	s = shortRE.ReplaceAllString(s, "<minute>")
	s = dayRE.ReplaceAllStringFunc(s, func(day string) string {
		if rel, ok := n.days[day]; ok {
			return rel
		}
		return day
	})
	s = millisRE.ReplaceAllString(s, "1700000000000")
	s = commitRE.ReplaceAllString(s, "<commit>")
	s = cursorRE.ReplaceAllString(s, "cursor=<cursor>")
	s = tokenRE.ReplaceAllString(s, "qd_<prefix>")
	s = weekRE.ReplaceAllString(s, "<week>")
	s = isoWeekRE.ReplaceAllString(s, "<week>")
	s = loopbackRE.ReplaceAllString(s, `"ip":"<loopback>"`)
	return s
}

// body is an answer's body: JSON with its keys in order and one value to a
// line, anything else as it is.
func (n *normaliser) body(raw []byte) string {
	text := n.text(string(raw))
	var v any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil || dec.More() {
		return text
	}
	v = sameEveryRun("", v)
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(v); err != nil {
		return text
	}
	return b.String()
}

// unordered are the lists the server reads in no order of its own: which
// row comes first is the database's choice, and differs from run to run
// where the rows' ids are made from other ids.
var unordered = map[string]bool{"mentioned_in": true, "mentions": true}

// sameEveryRun is a decoded answer with the values no two runs share made
// alike, and its unordered lists put in the order of their text.
func sameEveryRun(key string, v any) any {
	switch val := v.(type) {
	case map[string]any:
		delete(val, "duration_ms") // how long a webhook's receiver took: there or not, and never the same
		for k, inner := range val {
			val[k] = sameEveryRun(k, inner)
		}
	case []any:
		for i, inner := range val {
			val[i] = sameEveryRun("", inner)
		}
		if unordered[key] {
			sort.Slice(val, func(i, j int) bool { return fmt.Sprint(val[i]) < fmt.Sprint(val[j]) })
		}
	case string:
		if key == "next_cursor" && val != "" {
			return "<cursor>"
		}
		if key == "last_commit" && val != "" {
			return "<commit>"
		}
		if key == "secret" && val != "" {
			return "<secret>"
		}
		if key == "week" {
			return weeksAgo(val)
		}
	}
	return v
}

// weeksAgo names the Monday a week starts on by how many weeks before this
// week it is. As a day it would differ with the day of the week the test is
// run on, and week by week.
func weeksAgo(day string) string {
	var offset int
	at, err := time.Parse("2006-01-02", day)
	if _, scanErr := fmt.Sscanf(day, "<day%d>", &offset); scanErr == nil {
		at, err = time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, offset), nil
	}
	if err != nil {
		return day
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	thisWeek := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	return fmt.Sprintf("<week-%d>", int(thisWeek.Sub(at).Hours()/24/7))
}

// stream is the live stream's text with each event's data as body gives
// it, on one line.
func (n *normaliser) stream(text string) string {
	var b strings.Builder
	for line := range strings.SplitSeq(text, "\n") {
		if data, ok := strings.CutPrefix(line, "data: "); ok {
			var one bytes.Buffer
			if json.Compact(&one, []byte(n.body([]byte(data)))) == nil {
				b.WriteString("data: " + one.String() + "\n")
				continue
			}
		}
		b.WriteString(line + "\n")
	}
	return b.String()
}
