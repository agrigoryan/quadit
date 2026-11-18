package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestEventPayloads pins the data of every kind of event the engine
// writes, as the feed serves it: one scenario touches every change type it
// can, and each event's type and data are compared with
// testdata/events.golden. The data is what the web app, agents and
// integrations read, so a change to its keys, nesting, empty values or key
// order shows here. Ids are numbered by first appearance, and the clock is
// the test's, so the file is the same on every run. Run with
// QUADIT_UPDATE_EVENTS=1 to write the file again.
//
// On Postgres the data is stored as jsonb, which keeps neither key order nor
// spacing, so there the comparison is of the decoded JSON with every id made
// alike.
func TestEventPayloads(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		evs, _ := eventScenario(t, st, false)
		got := numbered(evs)
		const file = "testdata/events.golden"
		if os.Getenv("QUADIT_UPDATE_EVENTS") != "" && t.Name() == "TestEventPayloads/sqlite" {
			if err := os.WriteFile(file, []byte(strings.Join(got, "\n")+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			return
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		want := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
		exact := strings.HasSuffix(t.Name(), "/sqlite")
		for i := 0; i < len(got) || i < len(want); i++ {
			g, w := lineAt(got, i), lineAt(want, i)
			if !exact {
				g, w = jsonbForm(t, g), jsonbForm(t, w)
			}
			if g != w {
				t.Fatalf("event %d differs from %s:\n got  %s\n want %s", i+1, file, g, w)
			}
		}
	})
}

func lineAt(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return "(none)"
}

var anyID = regexp.MustCompile(`#\d+`)

// jsonbForm is a golden line as Postgres would give it back: keys in no
// particular order, so decoded and encoded again, and ids alike, since
// their numbering follows the order they are read in.
func jsonbForm(t *testing.T, line string) string {
	typ, data, ok := strings.Cut(line, " ")
	if !ok {
		return line
	}
	var v any
	if err := json.Unmarshal([]byte(anyID.ReplaceAllString(data, "#")), &v); err != nil {
		t.Fatalf("%s: %v", line, err)
	}
	out, _ := json.Marshal(v)
	return typ + " " + string(out)
}

// TestQuietEveryEvent checks that history brought in quietly says so in
// every event it writes, whatever the change: the scenario again, with every
// change quiet. A quiet event notifies nobody and sets off no rule; one that
// lost the mark would. The engine sets the mark on the one type every event's
// data is, so no event can be written without it.
func TestQuietEveryEvent(t *testing.T) {
	evs, quiet := eventScenario(t, testdb.SQLite(t), true)
	n := 0
	for _, ev := range evs {
		if !quiet[ev.ChangeID] {
			continue // written by the engine itself: a rule, an upkeep job
		}
		n++
		if d, err := ev.Payload(); err != nil || !d.Quiet {
			t.Errorf("%s of a quiet change is not marked quiet: %s", ev.Type, ev.Data)
		}
	}
	if n < 100 {
		t.Fatalf("only %d events came from quiet changes", n)
	}
}

// eventScenario runs every change type the engine has (and the background
// jobs that write events) in one workspace, and returns the events written
// and the ids of the changes it applied, each quiet if asked.
func eventScenario(t *testing.T, st store.Store, quiet bool) (evs []core.Event, applied map[string]bool) {
	ctx := context.Background()
	// The scenario keeps secrets too; sealing is not what it is about.
	e := New(st, func(plain string) (string, error) { return plain, nil })
	clock := time.Date(2026, 1, 5, 9, 0, 0, 0, time.UTC)
	e.now = func() time.Time {
		clock = clock.Add(time.Second)
		return clock
	}
	ws, owner, err := e.Bootstrap(ctx, BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram-events@example.com", OwnerHandle: "aram",
		WorkspaceSlug: "events", WorkspaceName: "Events"})
	if err != nil {
		t.Fatal(err)
	}
	ran, applied := map[string]bool{}, map[string]bool{}
	try := func(ch Change, actor string) (*Result, error) {
		ch.ID = id.New()
		ch.Quiet = ch.Quiet || quiet
		ran[ch.Type], applied[ch.ID] = true, true
		return e.Apply(ctx, ws.ID, Actor{UserID: actor}, ch)
	}
	as := func(actor, typ string, args any) *Result {
		t.Helper()
		raw, _ := json.Marshal(args)
		res, err := try(Change{Type: typ, Args: raw}, actor)
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		return res
	}
	do := func(typ string, args any) *Result {
		t.Helper()
		return as(owner.ID, typ, args)
	}
	type M = map[string]any
	file := func(name string) string {
		t.Helper()
		f := core.File{ID: id.New(), WorkspaceID: ws.ID, Name: name, ContentType: "image/png", Size: 3, StorageKey: "k/" + name,
			State: core.FileReady, UploadedBy: owner.ID, CreatedAt: e.Now()}
		if err := st.Write(ctx, ws.ID, func(tx store.Tx) error { return tx.Insert(ctx, f) }); err != nil {
			t.Fatal(err)
		}
		return f.ID
	}

	// The workspace and who is in it.
	do("workspace.update", M{"name": "Events and more"})
	artist := do("agent.create", M{"name": "Artist", "handle": "artist", "role": "admin", "scope": M{"needs_approval": []string{}}}).Ref
	do("agent.update", M{"id": "@artist", "description": "draws"})
	do("member.update", M{"id": "@artist", "title": "Painter"})
	_, _, err = e.Bootstrap(ctx, BootstrapArgs{OwnerName: "Bea", OwnerEmail: "bea-events@example.com", OwnerHandle: "bea",
		WorkspaceSlug: "elsewhere", WorkspaceName: "Elsewhere"})
	if err != nil {
		t.Fatal(err)
	}
	do("member.add", M{"user": "bea-events@example.com", "handle": "bea", "role": "member"})
	do("member.remove", M{"id": "@bea"})

	// Projects and what sorts their tasks.
	do("project.create", M{"key": "SVA", "name": "Samurai vs Alien", "settings": M{"cycles": true, "cycle_days": 7}})
	do("project.create", M{"key": "OPS", "name": "Operations"})
	do("project.update", M{"id": "OPS", "description": "the boring part"})
	do("status.create", M{"project": "SVA", "name": "Polish", "category": "started"})
	do("status.update", M{"id": "Polish", "color": "#123456"})
	do("label.create", M{"project": "SVA", "name": "art"})
	do("label.update", M{"id": "art", "color": "#ff0000"})
	do("label.create", M{"project": "SVA", "name": "sound"})
	epic := do("epic.create", M{"project": "SVA", "name": "Combat"}).Ref
	do("epic.update", M{"id": epic, "state": "active"})
	milestone := do("milestone.create", M{"epic": epic, "name": "Alpha"}).Ref
	do("milestone.update", M{"id": milestone, "description": "first playable"})
	cycle := do("cycle.create", M{"project": "SVA", "name": "Later", "starts_on": "2026-06-01", "ends_on": "2026-06-07"}).Ref
	do("cycle.update", M{"id": cycle, "name": "Much later"})
	var first core.Cycle
	if err := st.In(ws.ID).Get(ctx, &first, store.Eq("starts_on", "2026-01-04")); err != nil {
		t.Fatal(err)
	}
	tpl := do("template.create", M{"project": "SVA", "name": "Bug", "title": "Bug: "}).Ref
	do("template.update", M{"id": tpl, "description": "what broke"})
	view := do("view.create", M{"name": "Mine", "project": "SVA", "query": M{"assignee": []string{"me"}}, "shared": true}).Ref
	do("view.update", M{"id": view, "description": "my tasks"})
	pref := do("preference.create", M{"body": "Prefer small commits", "project": "SVA"}).Ref
	do("preference.update", M{"id": pref, "body": "Prefer small, clear commits"})

	// Tasks and what happens in them.
	do("task.create", M{"project": "SVA", "title": "Explosion effect", "assignee": "@artist", "labels": []string{"art", "sound"},
		"epic": epic, "milestone": milestone, "cycle": first.ID})
	do("task.create", M{"project": "SVA", "title": "Sword sound", "waiting_on": "@artist", "waiting_on_note": "pick one"})
	do("task.create", M{"project": "SVA", "title": "Title screen", "template": tpl})
	do("task.update", M{"id": "SVA-1", "title": "Big explosion", "priority": 2, "due_on": "2026-02-01"})
	do("task.update", M{"id": "SVA-2", "waiting_on": nil})
	as(artist, "task.take", M{"id": "SVA-1"})
	as(artist, "task.release", M{"id": "SVA-1"})
	do("watch.set", M{"type": "task", "subject": "SVA-2", "watching": false})
	do("watch.set", M{"type": "task", "subject": "SVA-2", "watching": true})
	rel := id.New()
	do("relation.add", M{"id": rel, "task": "SVA-1", "type": "blocks", "other": "SVA-2"})
	do("relation.remove", M{"id": rel})
	link, plain := id.New(), id.New()
	do("link.set", M{"id": link, "task": "SVA-1", "kind": "pr", "url": "https://example.com/pr/1", "title": "Explosions", "repo": "a/b", "ref": "1"})
	do("link.set", M{"id": link, "task": "SVA-1", "kind": "pr", "url": "https://example.com/pr/1", "repo": "a/b", "ref": "1", "state": "merged"})
	do("link.set", M{"id": plain, "task": "SVA-1", "kind": "url", "url": "https://example.com/notes"})
	do("link.set", M{"id": plain, "task": "SVA-1", "kind": "url", "url": "https://example.com/notes", "title": "Notes"})
	do("link.remove", M{"id": link})
	cm := do("comment.create", M{"task": "SVA-1", "body": "Looks good", "attachments": []M{{"file": file("a.png")}}}).Ref
	do("comment.update", M{"id": cm, "body": "Looks very good"})
	do("comment.update", M{"id": cm, "resolved": true})
	do("comment.delete", M{"id": cm})
	att := do("attachment.add", M{"task": "SVA-1", "file": file("b.png"), "caption": "first try"}).Ref
	do("attachment.remove", M{"id": att})
	do("attachment.restore", M{"id": att})
	dec := do("decision.open", M{"task": "SVA-1", "question": "Which one?", "recommended": 1, "ask": "@artist",
		"options": []M{{"label": "A", "attachments": []M{{"file": file("c.png")}}}, {"label": "B"}}}).Ref
	do("decision.update", M{"id": dec, "details": "both are fine"})
	as(artist, "decision.pick", M{"id": dec, "option": 1, "note": "A it is"})
	do("decision.unclear", M{"id": dec, "note": "which A?"})
	do("decision.delete", M{"id": dec})
	do("decision.restore", M{"id": dec})
	do("notify", M{"user": "@artist", "task": "SVA-1", "message": "have a look"})
	as(artist, "notification.read", M{"all": true})
	do("session.start", M{"task": "SVA-1", "title": "Drawing"})
	sess := do("session.start", M{"title": "Thinking"}).Ref
	do("session.update", M{"id": sess, "summary": "thought", "state": "done"})
	do("task.move", M{"id": "SVA-3", "project": "OPS"})
	do("task.delete", M{"id": "SVA-2"})
	do("task.restore", M{"id": "SVA-2"})
	do("agent.create", M{"name": "Helper", "handle": "helper", "task": "SVA-2"})
	do("task.update", M{"id": "SVA-2", "status": "Done"}) // its sub-agent is ended

	// The engine at work by itself: a rule, history brought in quietly, the
	// cycle rolling over.
	rule := do("rule.create", M{"name": "Ping", "match": M{"event_types": []string{"task.updated"}}, "action": M{"kind": "notify", "user_id": owner.ID, "message": "x"}}).Ref
	do("rule.update", M{"id": rule, "name": "Ping me", "match": M{"event_types": []string{"task.updated"}}, "action": M{"kind": "notify", "user_id": owner.ID, "message": "y"}})
	if err := e.System(ctx, ws.ID, owner.ID, func(s *Sys) error {
		s.From(rule)
		return s.Do("task.update", M{"id": "SVA-1", "priority": 1})
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(M{"project": "SVA", "title": "Imported", "assignee": "@artist"})
	if _, err := try(Change{Type: "task.create", Args: raw, Quiet: true}, owner.ID); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(8 * 24 * time.Hour)
	if err := e.RollCycles(ctx); err != nil {
		t.Fatal(err)
	}
	do("task.update", M{"id": "SVA-1", "cycle": nil})
	clock = clock.Add(7 * 24 * time.Hour)
	if err := e.RollCycles(ctx); err != nil { // nothing left to roll over
		t.Fatal(err)
	}

	// Resources, and holds on them that pass on and run out.
	do("resource.create", M{"name": "gpu"})
	do("resource.acquire", M{"resource": "gpu", "task": "SVA-1"})
	as(artist, "resource.acquire", M{"resource": "gpu"})
	do("resource.release", M{"resource": "gpu"})
	clock = clock.Add(24 * time.Hour)
	if err := e.ExpireHolds(ctx); err != nil {
		t.Fatal(err)
	}
	do("resource.delete", M{"id": "gpu"})

	// What reaches outside.
	hook := do("webhook.create", M{"name": "out", "url": "https://example.com/hook"}).Ref
	do("webhook.update", M{"id": hook, "active": false})
	do("webhook.delete", M{"id": hook})
	integ := do("integration.create", M{"kind": "github", "name": "gh"}).Ref
	do("integration.update", M{"id": integ, "active": false})
	do("integration.delete", M{"id": integ})
	secret := do("secret.set", M{"name": "TOKEN", "value": "s3cret"}).Ref
	do("secret.set", M{"id": secret, "name": "TOKEN", "description": "for builds"})
	do("secret.send", M{"name": "TOKEN", "method": "POST", "url": "https://example.com/build"})
	do("secret.delete", M{"id": secret})

	// Pages, databases and their history.
	page := do("doc.create", M{"title": "Plan", "project": "SVA", "markdown": "# Plan\n\nFirst para.\n"}).Ref
	do("doc.create", M{"title": "Empty"})
	para := id.New()
	do("doc.edit", M{"doc": page, "ops": []M{{"op": "insert", "block": M{"id": para, "type": "paragraph", "content": "Second para."}}}})
	do("doc.edit", M{"doc": page, "ops": []M{{"op": "delete", "id": para}}})
	do("doc.snapshot", M{"doc": page, "label": "v1"})
	var ver core.DocVersion
	if err := st.In(ws.ID).Get(ctx, &ver, store.Eq("label", "v1")); err != nil {
		t.Fatal(err)
	}
	do("doc.write", M{"doc": page, "markdown": "# Plan\n\nAll new.\n"})
	do("doc.revert", M{"doc": page, "version": ver.ID})
	do("doc.update", M{"id": page, "title": "The plan"})
	do("comment.create", M{"doc": page, "body": "on the page"})
	pcm := do("comment.create", M{"doc": page, "body": "another"}).Ref
	do("comment.update", M{"id": pcm, "resolved": true})
	do("comment.delete", M{"id": pcm})
	do("attachment.add", M{"doc": page, "file": file("d.png")})
	mine := do("doc.create", M{"title": "Mine", "private": true}).Ref
	do("doc.update", M{"id": mine, "shared_with": []string{"@artist"}})
	do("doc.update", M{"id": mine, "shared_with": []string{}})
	do("doc.create", M{"title": "Details", "parent": page})
	do("doc.update", M{"id": page, "project": "OPS"})
	db := do("doc.create", M{"title": "Assets", "kind": "database"}).Ref
	prop := do("property.create", M{"database": db, "name": "Kind", "type": "select"}).Ref
	do("property.update", M{"id": prop, "database": db, "name": "Sort"})
	row := do("doc.create", M{"title": "Sword", "parent": db}).Ref
	do("doc.update", M{"id": row, "props": M{prop: "blade"}})
	do("property.update", M{"id": prop, "database": db, "rename_option": M{"from": "blade", "to": "edge"}})
	dbv := do("dbview.create", M{"database": db, "name": "Board", "type": "board"}).Ref
	do("dbview.update", M{"id": dbv, "database": db, "name": "Kanban"})
	do("dbview.delete", M{"id": dbv})
	do("property.delete", M{"id": prop})
	src := do("source.create", M{"title": "Docs", "repo": "/tmp/nowhere"}).Ref
	do("source.update", M{"id": src, "branch": "main"})
	do("source.delete", M{"id": src})
	do("doc.delete", M{"id": mine})
	do("doc.delete", M{"id": row})
	do("doc.restore", M{"id": row})

	// Taking things apart.
	do("label.delete", M{"id": "sound"})
	do("milestone.delete", M{"id": milestone})
	do("epic.delete", M{"id": epic})
	do("status.delete", M{"id": "Polish", "move_to": "Backlog"})
	do("cycle.delete", M{"id": cycle})
	do("template.delete", M{"id": tpl})
	do("view.delete", M{"id": view})
	do("preference.delete", M{"id": pref})
	do("rule.delete", M{"id": rule})
	do("project.delete", M{"id": "OPS"})

	// Upkeep: what a restore announces, and the trash emptied, with a task
	// in it.
	t1 := do("task.create", M{"project": "SVA", "title": "Restored"}).Ref
	thrown := do("task.create", M{"project": "SVA", "title": "Thrown away"}).Ref
	do("task.delete", M{"id": thrown})
	if err := e.RestoreFromBackup(ctx, ws.ID, "task", t1, func(store.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := e.RestoreFromBackup(ctx, ws.ID, "doc", page, func(store.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(60 * 24 * time.Hour)
	if _, _, err := e.PurgeTrash(ctx, 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}

	// What is put back as it was: an inbox taken out and back in, and an
	// epic, a milestone and a cycle taken out of the trash.
	as(artist, "notification.read", M{"all": true, "archive": true})
	as(artist, "notification.read", M{"all": true, "unarchive": true})
	epic = do("epic.create", M{"project": "SVA", "name": "Stealth"}).Ref
	milestone = do("milestone.create", M{"epic": epic, "name": "Beta"}).Ref
	cycle = do("cycle.create", M{"project": "SVA", "starts_on": "2027-01-04", "ends_on": "2027-01-10"}).Ref
	do("epic.delete", M{"id": epic})
	do("milestone.delete", M{"id": milestone})
	do("cycle.delete", M{"id": cycle})
	do("epic.restore", M{"id": epic})
	do("milestone.restore", M{"id": milestone})
	do("cycle.restore", M{"id": cycle})

	// A mistake put right at once: the undo names the change it takes back,
	// and the inbox item that change made goes with it.
	wrong := do("task.create", M{"project": "SVA", "title": "Made by mistake", "assignee": "@artist"})
	raw, _ = json.Marshal(M{"id": wrong.Ref})
	if _, err := try(Change{Type: "task.delete", Args: raw, Undoes: wrong.ChangeID}, owner.ID); err != nil {
		t.Fatal(err)
	}

	// A thread on words of a page: the words get its marker, an edit that
	// takes them out detaches it, an undo puts it back, and deleting it
	// takes the marker off.
	notes := do("doc.create", M{"title": "Notes", "markdown": "The boss has three phases.\n"}).Ref
	var words core.Block
	if err := st.In(ws.ID).Get(ctx, &words, store.Eq("doc_id", notes)); err != nil {
		t.Fatal(err)
	}
	onWords := do("comment.create", M{"doc": notes, "block": words.ID, "quote": "three phases", "body": "Four?"}).Ref
	if err := st.In(ws.ID).Get(ctx, &words, store.Eq("id", words.ID)); err != nil {
		t.Fatal(err)
	}
	do("doc.edit", M{"doc": notes, "ops": []M{{"op": "update", "id": words.ID, "content": "The boss is gone."}}})
	do("doc.edit", M{"doc": notes, "ops": []M{{"op": "update", "id": words.ID, "content": words.Content}}})
	do("comment.delete", M{"id": onWords})

	do("workspace.delete", M{"confirm": "events"})

	for _, typ := range ChangeTypes() {
		if !ran[typ] {
			t.Errorf("the scenario does not run %s: add it, so the events it writes are pinned too", typ)
		}
	}

	evs, err = st.In(ws.ID).Events(ctx, store.EventFilter{Limit: 100000})
	if err != nil {
		t.Fatal(err)
	}
	return evs, applied
}

// numbered gives each event as "type data", its ids numbered by first
// appearance.
func numbered(evs []core.Event) []string {
	ids := map[string]string{}
	number := func(s string) string {
		return uuidish.ReplaceAllStringFunc(s, func(u string) string {
			if n, ok := ids[u]; ok {
				return n
			}
			ids[u] = fmt.Sprintf("#%d", len(ids)+1)
			return ids[u]
		})
	}
	var lines []string
	for _, ev := range evs {
		data := bytes.TrimSpace(ev.Data)
		lines = append(lines, ev.Type+" "+number(string(data)))
	}
	return lines
}

var uuidish = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
