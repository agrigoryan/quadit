package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestRefusalsOfMissingArguments pins how every change type refuses an
// argument that is left out, as testdata/missing.golden. One scenario sends
// each change type once, with arguments that are accepted; just before it
// does, it checks (as a dry run) the request with nothing in it, and for
// each argument it sent, the request without that argument with the others
// as they were. Where that is refused, it checks it again with every other
// argument given a wrong value, which shows whether "it is missing" is said
// before anything else wrong. Run with QUADIT_UPDATE_MISSING=1 to write the
// file again.
func TestRefusalsOfMissingArguments(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		got := missingScenario(t, st).lines
		const file = "testdata/missing.golden"
		if os.Getenv("QUADIT_UPDATE_MISSING") != "" && strings.HasSuffix(t.Name(), "/sqlite") {
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
		for i := 0; i < len(got) || i < len(want); i++ {
			if g, w := lineOf(got, i), lineOf(want, i); g != w {
				t.Fatalf("line %d differs from %s:\n got  %s\n want %s", i+1, file, g, w)
			}
		}
	})
}

// TestRequiredArgumentsAreTheOnesRefused holds the catalog's "required" (the
// quadit:"required" tags) to what the changes do. A required argument left
// out of an otherwise accepted request is refused, naming it. An argument
// that is not required either was not needed by the scenario's accepted
// request, or could be left out of it, or is needed only sometimes: those
// are listed here with the reason.
func TestRequiredArgumentsAreTheOnesRefused(t *testing.T) {
	t.Parallel()
	sometimes := map[string]string{
		"task.create project":      "or the parent's project",
		"task.create title":        "or the template's title",
		"comment.create task":      "or doc, block, decision or option",
		"attachment.add task":      "or comment, decision, option or doc",
		"decision.pick option":     "not when the outcome sends the question back",
		"notification.read all":    "or ids, or task",
		"link.set url":             "only for a url link; the others need ref",
		"secret.set value":         "only for a new secret",
		"integration.create kind":  "integration.update reads the same arguments, where it may be left out",
		"rule.create name":         "rule.update reads the same arguments, where it may be left out",
		"rule.create action":       "rule.update reads the same arguments, where it may be left out",
		"rule.update id":           "rule.create reads the same arguments, where it is made up when left out",
		"integration.update id":    "integration.create reads the same arguments, where it is made up when left out",
		"source.create repo":       "source.update reads the same arguments, where it may be left out",
		"source.update id":         "source.create reads the same arguments, where it is made up when left out",
		"property.create database": "property.update reads the same arguments, where it may be left out",
		"property.create name":     "property.update reads the same arguments, where it may be left out",
		"property.update id":       "property.create reads the same arguments, where it is made up when left out",
		"dbview.create database":   "dbview.update reads the same arguments, where it may be left out",
		"dbview.update id":         "dbview.create reads the same arguments, where it is made up when left out",
	}
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := missingScenario(t, st)
		for _, ci := range engine.Catalog() {
			for _, a := range ci.Args {
				key := ci.Type + " " + a.Name
				sent := slices.Contains(p.sent[ci.Type], a.Name)
				switch reason, listed := sometimes[key]; {
				case a.Required && !sent:
					t.Errorf("%s is required, yet the scenario's request did without it", key)
				case a.Required && !p.refused[ci.Type][a.Name]:
					t.Errorf("%s is required, yet a request without it is accepted", key)
				case a.Required && listed:
					t.Errorf("%s is required, and also listed as needed only sometimes (%s)", key, reason)
				case !a.Required && p.refused[ci.Type][a.Name] && !listed:
					t.Errorf("%s is refused when left out: tag it required, or list here why it is needed only sometimes", key)
				case !a.Required && listed && !p.refused[ci.Type][a.Name]:
					t.Errorf("%s is listed as needed sometimes, yet the scenario does without it: take it off the list", key)
				}
			}
		}
	})
}

func lineOf(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return "(none)"
}

// probes is what the scenario found: the golden lines, and for each change
// type the arguments it was sent with and which of them it refused to go
// without.
type probes struct {
	lines   []string
	sent    map[string][]string        // change type -> the arguments of its accepted request
	refused map[string]map[string]bool // change type -> argument -> refused when left out
}

var uuidLike = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// missingScenario sends every change type once, probing each first.
func missingScenario(t *testing.T, st store.Store) *probes {
	ctx := context.Background()
	e := engine.New(st, func(plain string) (string, error) { return plain, nil })
	ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram-missing@example.com",
		OwnerHandle: "aram", WorkspaceSlug: "missing", WorkspaceName: "Missing"})
	if err != nil {
		t.Fatal(err)
	}
	p := &probes{sent: map[string][]string{}, refused: map[string]map[string]bool{}}
	catalog := map[string][]engine.ArgInfo{}
	for _, ci := range engine.Catalog() {
		catalog[ci.Type] = ci.Args
	}
	refusal := func(actor, typ string, args map[string]any) string {
		raw, _ := json.Marshal(args)
		_, err := e.Batch(ctx, ws.ID, engine.Actor{UserID: actor}, []engine.Change{{ID: id.New(), Type: typ, Args: raw}}, true)
		if err == nil {
			return "ok"
		}
		var ee *engine.Error
		if !errors.As(err, &ee) {
			t.Fatalf("%s %v: %v", typ, args, err)
		}
		return uuidLike.ReplaceAllString(fmt.Sprintf("%s [%s] %s", ee.Code, ee.Field, ee.Message), "<id>")
	}
	as := func(actor, typ string, args map[string]any) *engine.Result {
		t.Helper()
		if _, done := p.sent[typ]; !done {
			p.sent[typ] = slices.Sorted(maps.Keys(args))
			p.refused[typ] = map[string]bool{}
			p.lines = append(p.lines, typ+" {}: "+refusal(actor, typ, map[string]any{}))
			for _, name := range p.sent[typ] {
				without := maps.Clone(args)
				delete(without, name)
				r := refusal(actor, typ, without)
				p.refused[typ][name] = r != "ok"
				p.lines = append(p.lines, typ+" -"+name+": "+r)
				if r == "ok" {
					continue
				}
				wrong := map[string]any{}
				for _, a := range catalog[typ] {
					if v, ok := wrongValue(a.Type); ok && a.Name != name {
						wrong[a.Name] = v
					}
				}
				p.lines = append(p.lines, typ+" -"+name+" others wrong: "+refusal(actor, typ, wrong))
			}
		}
		raw, _ := json.Marshal(args)
		res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: actor}, engine.Change{ID: id.New(), Type: typ, Args: raw})
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		return res
	}
	do := func(typ string, args M) *engine.Result {
		t.Helper()
		return as(owner.ID, typ, args)
	}
	file := func(name string) string {
		t.Helper()
		f := core.File{ID: id.New(), WorkspaceID: ws.ID, Name: name, ContentType: "image/png", Size: 3, StorageKey: "k/" + name,
			State: core.FileReady, UploadedBy: owner.ID, CreatedAt: e.Now()}
		if err := st.Write(ctx, ws.ID, func(tx store.Tx) error { return tx.Insert(ctx, f) }); err != nil {
			t.Fatal(err)
		}
		return f.ID
	}
	get := func(v any, conds ...store.Cond) {
		t.Helper()
		if err := st.In(ws.ID).Get(ctx, v, conds...); err != nil {
			t.Fatal(err)
		}
	}

	// The workspace and who is in it.
	do("workspace.update", M{"name": "Missing and more"})
	artist := do("agent.create", M{"name": "Artist", "handle": "artist", "role": "admin", "scope": M{"needs_approval": []string{}}}).Ref
	do("agent.update", M{"id": "@artist", "description": "draws"})
	do("member.update", M{"id": "@artist", "title": "Painter"})
	if _, _, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Bea", OwnerEmail: "bea-missing@example.com",
		OwnerHandle: "bea", WorkspaceSlug: "elsewhere", WorkspaceName: "Elsewhere"}); err != nil {
		t.Fatal(err)
	}
	do("member.add", M{"user": "bea-missing@example.com", "handle": "bea", "role": "member"})
	do("member.remove", M{"id": "@bea"})

	// Projects and what sorts their tasks.
	do("project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
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
	tpl := do("template.create", M{"project": "SVA", "name": "Bug", "title": "Bug: "}).Ref
	do("template.update", M{"id": tpl, "description": "what broke"})
	view := do("view.create", M{"name": "Mine", "project": "SVA", "query": M{"assignee": []string{"me"}}, "shared": true}).Ref
	do("view.update", M{"id": view, "description": "my tasks"})
	pref := do("preference.create", M{"body": "Prefer small commits", "project": "SVA"}).Ref
	do("preference.update", M{"id": pref, "body": "Prefer small, clear commits"})

	// Tasks and what happens in them.
	do("task.create", M{"project": "SVA", "title": "Explosion effect", "assignee": "@artist", "labels": []string{"art"}})
	do("task.create", M{"project": "SVA", "title": "Sword sound"})
	do("task.create", M{"project": "SVA", "title": "Title screen"})
	do("task.update", M{"id": "SVA-1", "title": "Big explosion"})
	as(artist, "task.take", M{"id": "SVA-1"})
	as(artist, "task.release", M{"id": "SVA-1"})
	do("watch.set", M{"type": "task", "subject": "SVA-2", "watching": true})
	rel := do("relation.add", M{"task": "SVA-1", "type": "blocks", "other": "SVA-2"}).Ref
	do("relation.remove", M{"id": rel})
	link := do("link.set", M{"task": "SVA-1", "kind": "url", "url": "https://example.com/notes"}).Ref
	do("link.remove", M{"id": link})
	cm := do("comment.create", M{"task": "SVA-1", "body": "Looks good"}).Ref
	do("comment.update", M{"id": cm, "body": "Looks very good"})
	do("comment.delete", M{"id": cm})
	att := do("attachment.add", M{"task": "SVA-1", "file": file("b.png")}).Ref
	do("attachment.remove", M{"id": att})
	do("attachment.restore", M{"id": att})
	dec := do("decision.open", M{"task": "SVA-1", "question": "Which one?", "ask": "@artist", "options": []M{{"label": "A"}, {"label": "B"}}}).Ref
	do("decision.update", M{"id": dec, "details": "both are fine"})
	as(artist, "decision.pick", M{"id": dec, "option": 1})
	do("decision.unclear", M{"id": dec, "note": "which A?"})
	do("decision.delete", M{"id": dec})
	do("decision.restore", M{"id": dec})
	do("notify", M{"user": "@artist", "message": "have a look"})
	as(artist, "notification.read", M{"all": true})
	sess := do("session.start", M{"title": "Thinking"}).Ref
	do("session.update", M{"id": sess, "summary": "thought"})
	// A run Quadit's runner started, whose runner is away: a stop ends it.
	var sva core.Project
	get(&sva, store.Eq("key", "SVA"))
	var first core.Task
	get(&first, store.Eq("key", "SVA-1"))
	run := core.AgentSession{ID: id.New(), WorkspaceID: ws.ID, AgentID: artist, TaskID: first.ID, State: core.AgentSessionRunning, StartedAt: e.Now(),
		Program: core.ProgramClaude, MachineID: "3f9c0a7d5e21b864", MachineName: "Studio", Folder: "~/game"}
	if err := st.Write(ctx, ws.ID, func(tx store.Tx) error { return tx.Insert(ctx, run) }); err != nil {
		t.Fatal(err)
	}
	do("session.stop", M{"id": run.ID})
	do("task.move", M{"id": "SVA-3", "project": "OPS"})
	do("task.delete", M{"id": "SVA-2"})
	do("task.restore", M{"id": "SVA-2"})
	do("rule.create", M{"name": "Ping", "match": M{"event_types": []string{"task.updated"}}, "action": M{"kind": "notify", "user_id": owner.ID, "message": "x"}})
	var rule core.Rule
	get(&rule, store.Eq("name", "Ping"))
	do("rule.update", M{"id": rule.ID, "name": "Ping me"})

	// Resources.
	do("resource.create", M{"name": "gpu"})
	do("resource.acquire", M{"resource": "gpu"})
	do("resource.release", M{"resource": "gpu"})
	do("resource.delete", M{"id": "gpu"})

	// What reaches outside.
	hook := do("webhook.create", M{"name": "out", "url": "https://example.com/hook"}).Ref
	do("webhook.update", M{"id": hook, "active": false})
	do("webhook.delete", M{"id": hook})
	integ := do("integration.create", M{"kind": "github", "name": "gh"}).Ref
	do("integration.update", M{"id": integ, "active": false})
	do("integration.delete", M{"id": integ})
	secret := do("secret.set", M{"name": "TOKEN", "value": "s3cret"}).Ref
	do("secret.send", M{"name": "TOKEN", "method": "POST", "url": "https://example.com/{{secret}}"})
	do("secret.delete", M{"id": secret})

	// Pages, databases and their history.
	page := do("doc.create", M{"title": "Plan", "markdown": "# Plan\n\nFirst para.\n"}).Ref
	do("doc.edit", M{"doc": page, "ops": []M{{"op": "insert", "block": M{"type": "paragraph", "content": "Second para."}}}})
	do("doc.snapshot", M{"doc": page, "label": "v1"})
	var ver core.DocVersion
	get(&ver, store.Eq("label", "v1"))
	do("doc.write", M{"doc": page, "markdown": "# Plan\n\nAll new.\n"})
	do("doc.revert", M{"doc": page, "version": ver.ID})
	do("doc.update", M{"id": page, "title": "The plan"})
	db := do("doc.create", M{"title": "Assets", "kind": "database"}).Ref
	prop := do("property.create", M{"database": db, "name": "Kind", "type": "select"}).Ref
	do("property.update", M{"id": prop, "name": "Sort"})
	dbv := do("dbview.create", M{"database": db, "name": "Board", "type": "board"}).Ref
	do("dbview.update", M{"id": dbv, "name": "Kanban"})
	do("dbview.delete", M{"id": dbv})
	do("property.delete", M{"id": prop})
	src := do("source.create", M{"title": "Docs", "repo": "/tmp/nowhere"}).Ref
	do("source.update", M{"id": src, "branch": "main"})
	do("source.delete", M{"id": src})
	do("doc.delete", M{"id": db})
	do("doc.restore", M{"id": db})

	// Taking things apart.
	do("label.delete", M{"id": "sound"})
	do("milestone.delete", M{"id": milestone})
	do("epic.delete", M{"id": epic})
	do("status.delete", M{"id": "Polish", "move_to": "Backlog"})
	do("cycle.delete", M{"id": cycle})
	do("epic.restore", M{"id": epic})
	do("milestone.restore", M{"id": milestone})
	do("cycle.restore", M{"id": cycle})
	do("template.delete", M{"id": tpl})
	do("view.delete", M{"id": view})
	do("preference.delete", M{"id": pref})
	do("rule.delete", M{"id": rule.ID})
	do("samples.add", M{"agent": "@artist"})
	do("samples.remove", M{})
	do("project.delete", M{"id": "OPS"})
	do("workspace.delete", M{"confirm": ws.Slug})

	for _, typ := range engine.ChangeTypes() {
		if _, ok := p.sent[typ]; !ok {
			t.Errorf("the scenario does not send %s: add it", typ)
		}
	}
	return p
}

// wrongValue is a value of an argument's type that no change accepts where
// it names something or must have a shape: text that names nothing and is
// no id, a negative number. Arguments of other types are left out.
func wrongValue(typ string) (any, bool) {
	switch strings.TrimSuffix(typ, "|null") {
	case "string":
		return "zz", true
	case "integer", "number":
		return -7, true
	case "[string]":
		return []string{"zz"}, true
	}
	return nil, false
}
