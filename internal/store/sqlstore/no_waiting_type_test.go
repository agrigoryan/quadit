package sqlstore_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeMakesWaitingStatusesStarted: before version 33 a status could
// be of the type waiting. The upgrade makes each such status started, with
// its name, color and place kept and its tasks where they were, and
// rewrites what named the type in rules, templates, GitHub integrations and
// the statuses' events in the feed. Saved views are left as they were.
func TestUpgradeMakesWaitingStatusesStarted(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 32)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			do := func(typ string, args map[string]any) string {
				t.Helper()
				raw, _ := json.Marshal(args)
				res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: typ, Args: raw})
				if err != nil {
					t.Fatalf("%s: %v", typ, err)
				}
				return res.Ref
			}
			db := st.In(ws.ID)
			insert := func(row any) {
				t.Helper()
				if err := db.Insert(ctx, row); err != nil {
					t.Fatal(err)
				}
			}
			// SVA has a status called Waiting; OPS calls its own Blocked.
			sva := do("project.create", map[string]any{"key": "SVA", "name": "Game"})
			ops := do("project.create", map[string]any{"key": "OPS", "name": "Operations"})
			waiting := core.Status{ID: id.New(), WorkspaceID: ws.ID, ProjectID: sva, Name: "Waiting", Color: "#8b5cf6", Category: "waiting", Rank: "000000035s", CreatedAt: 1, UpdatedSeq: 1}
			blocked := core.Status{ID: id.New(), WorkspaceID: ws.ID, ProjectID: ops, Name: "Blocked", Color: "#c26a00", Category: "waiting", Rank: "000000036s", CreatedAt: 1, UpdatedSeq: 1}
			insert(waiting)
			insert(blocked)
			do("task.create", map[string]any{"project": "SVA", "title": "Boss fight"})
			if _, err := db.Update(ctx, "tasks", map[string]any{"status_id": waiting.ID}, store.Eq("key", "SVA-1")); err != nil {
				t.Fatal(err)
			}
			view := func(query string) (string, string) {
				t.Helper()
				v := core.View{ID: id.New(), WorkspaceID: ws.ID, Name: "v", Slug: id.New(), OwnerID: owner.ID, Shared: true,
					Query: json.RawMessage(query), Layout: "list", Rank: "a", CreatedAt: 1, UpdatedSeq: 1}
				insert(v)
				return v.ID, query
			}
			// Saved views are left as they were: read, a type there is no more
			// is left out with a note (the engine's TaskFilter).
			views := [][2]string{}
			for _, q := range []string{`{"category":["waiting"],"status":null}`, `{"status":["waiting"]}`, `null`} {
				id, query := view(q)
				views = append(views, [2]string{id, query})
			}

			rule := func(match core.RuleMatch) string {
				t.Helper()
				r := core.Rule{ID: id.New(), WorkspaceID: ws.ID, Name: "r", Active: true, Match: &match, Action: &core.RuleAction{Kind: core.RuleNotify, UserID: owner.ID},
					CreatedBy: owner.ID, CreatedAt: 1, UpdatedSeq: 1}
				insert(r)
				return r.ID
			}
			intoWaiting := rule(core.RuleMatch{EventTypes: []string{"task.updated"}, ToCategory: "waiting"})
			intoDone := rule(core.RuleMatch{EventTypes: []string{"task.updated"}, ToCategory: "done"})
			insert(core.Rule{ID: id.New(), WorkspaceID: ws.ID, Name: "no match", Active: true, Action: &core.RuleAction{Kind: core.RuleNotify, UserID: owner.ID},
				CreatedBy: owner.ID, CreatedAt: 1, UpdatedSeq: 1})

			template := func(project, preset string) string {
				t.Helper()
				tp := core.Template{ID: id.New(), WorkspaceID: ws.ID, ProjectID: project, Name: "t", Preset: json.RawMessage(preset), CreatedAt: 1, UpdatedSeq: 1}
				insert(tp)
				return tp.ID
			}
			// "waiting" is the type unless the row's own project has a status
			// called that.
			templates := []struct{ id, want string }{
				{template(ops, `{"status":"waiting","priority":2}`), `{"status":"started","priority":2}`},
				{template(sva, `{"status":" Waiting "}`), `{"status":" Waiting "}`},
				{template("", `{"status":"WAITING"}`), `{"status":"started"}`},
				{template("", `{"status":null}`), `{"status":null}`},
				{template(ops, `null`), `null`},
				{template(ops, `"waiting"`), `"waiting"`},
			}

			integration := func(project, config string) string {
				t.Helper()
				in := core.Integration{ID: id.New(), WorkspaceID: ws.ID, Kind: "github", ProjectID: project, Name: "gh", Config: json.RawMessage(config), Active: true,
					CreatedBy: owner.ID, CreatedAt: 1, UpdatedSeq: 1}
				insert(in)
				return in.ID
			}
			integrations := []struct{ id, want string }{
				{integration(ops, `{"repo":"acme/ops","on_open":"waiting","on_merge":"done"}`), `{"repo":"acme/ops","on_open":"started","on_merge":"done"}`},
				{integration(sva, `{"repo":"acme/game","on_merge":"waiting "}`), `{"repo":"acme/game","on_merge":"waiting "}`},
				{integration("", `{"repo":"acme/all","on_open":"waiting","on_merge":"Waiting"}`), `{"repo":"acme/all","on_open":"started","on_merge":"started"}`},
				{integration("", `null`), `null`},
				{integration("", `[]`), `[]`},
			}

			// The statuses' events as the engine of before wrote them, and one
			// of another kind that says waiting.
			events := []struct{ typ, entity, data, want string }{
				{"status.created", "status", `{"row":{"id":"` + blocked.ID + `","name":"Blocked","category":"waiting"}}`, `{"row":{"id":"` + blocked.ID + `","name":"Blocked","category":"started"}}`},
				{"status.updated", "status", `{"id":"` + blocked.ID + `","changes":{"category":{"from":"started","to":"waiting"}}}`, `{"id":"` + blocked.ID + `","changes":{"category":{"from":"started","to":"started"}}}`},
				{"status.updated", "status", `{"id":"` + blocked.ID + `","changes":{"category":{"from":"waiting","to":"done"}}}`, `{"id":"` + blocked.ID + `","changes":{"category":{"from":"started","to":"done"}}}`},
				{"session.created", "session", `{"row":{"id":"x","state":"waiting","category":"waiting"}}`, ""},
				{"status.updated", "status", `{"changes":{"category":"waiting"}}`, ""},
				{"status.updated", "status", `{"row":null}`, ""},
				{"status.updated", "status", `null`, ""},
				{"status.updated", "status", `[1]`, ""},
			}
			for i, ev := range events {
				insert(core.Event{WorkspaceID: ws.ID, Seq: int64(9000 + i), At: 1, ActorID: owner.ID, ChangeID: id.New(), Type: ev.typ,
					EntityType: ev.entity, EntityID: blocked.ID, ScopeType: "project", ScopeID: ops, ProjectID: ops, Data: json.RawMessage(ev.data)})
			}

			upgrade(t, st)

			t.Run("statuses", func(t *testing.T) {
				for _, was := range []core.Status{waiting, blocked} {
					var now core.Status
					if err := db.Get(ctx, &now, store.Eq("id", was.ID)); err != nil {
						t.Fatal(err)
					}
					was.Category = core.CatStarted
					if now != was {
						t.Errorf("after the upgrade:\n got  %+v\n want %+v", now, was)
					}
				}
				var task core.Task
				if err := db.Get(ctx, &task, store.Eq("key", "SVA-1")); err != nil {
					t.Fatal(err)
				}
				if task.StatusID != waiting.ID {
					t.Errorf("SVA-1 moved to %s", task.StatusID)
				}
			})
			sameJSON := func(t *testing.T, what string, got json.RawMessage, want string) {
				t.Helper()
				var g, w any
				if len(got) == 0 {
					got = json.RawMessage(`null`)
				}
				if err := json.Unmarshal(got, &g); err != nil {
					t.Fatalf("%s: %s: %v", what, got, err)
				}
				if err := json.Unmarshal([]byte(want), &w); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(g, w) {
					t.Errorf("%s after the upgrade:\n got  %s\n want %s", what, got, want)
				}
			}
			t.Run("saved views", func(t *testing.T) {
				for _, v := range views {
					var got core.View
					if err := db.Get(ctx, &got, store.Eq("id", v[0])); err != nil {
						t.Fatal(err)
					}
					sameJSON(t, "view", got.Query, v[1])
				}
			})
			t.Run("rules", func(t *testing.T) {
				var off, on core.Rule
				if err := db.Get(ctx, &off, store.Eq("id", intoWaiting)); err != nil {
					t.Fatal(err)
				}
				if err := db.Get(ctx, &on, store.Eq("id", intoDone)); err != nil {
					t.Fatal(err)
				}
				if off.Active || off.Match.ToCategory != core.CatStarted {
					t.Errorf("the rule on a move into waiting: active %v, to %q", off.Active, off.Match.ToCategory)
				}
				if !on.Active || on.Match.ToCategory != core.CatDone {
					t.Errorf("the rule on a move into done: active %v, to %q", on.Active, on.Match.ToCategory)
				}
			})
			t.Run("templates", func(t *testing.T) {
				for _, tp := range templates {
					var got core.Template
					if err := db.Get(ctx, &got, store.Eq("id", tp.id)); err != nil {
						t.Fatal(err)
					}
					sameJSON(t, "template", got.Preset, tp.want)
				}
			})
			t.Run("integrations", func(t *testing.T) {
				for _, in := range integrations {
					var got core.Integration
					if err := db.Get(ctx, &got, store.Eq("id", in.id)); err != nil {
						t.Fatal(err)
					}
					sameJSON(t, "integration", got.Config, in.want)
				}
			})
			t.Run("events", func(t *testing.T) {
				for i, ev := range events {
					var got core.Event
					if err := db.Get(ctx, &got, store.Eq("seq", 9000+i)); err != nil {
						t.Fatal(err)
					}
					want := ev.want
					if want == "" {
						want = ev.data
					}
					sameJSON(t, ev.typ, got.Data, want)
				}
			})
			// An archive made before this version still loads, and comes out
			// with its waiting statuses started.
			t.Run("an older archive", func(t *testing.T) {
				old := core.Status{ID: id.New(), WorkspaceID: ws.ID, ProjectID: ops, Name: "On hold", Color: "#c26a00", Category: "waiting", Rank: "000000037s", CreatedAt: 1, UpdatedSeq: 1}
				if err := st.Load(ctx, "statuses", []map[string]any{{"id": old.ID, "workspace_id": ws.ID, "project_id": ops, "name": old.Name, "color": old.Color,
					"category": old.Category, "rank": old.Rank, "is_default": false, "created_at": 1, "updated_seq": 1}}); err != nil {
					t.Fatal(err)
				}
				if err := st.UpgradeLoaded(ctx, 32); err != nil {
					t.Fatal(err)
				}
				var now core.Status
				if err := db.Get(ctx, &now, store.Eq("id", old.ID)); err != nil {
					t.Fatal(err)
				}
				if now.Category != core.CatStarted || now.Name != old.Name {
					t.Errorf("the archive's status after the upgrade: %+v", now)
				}
			})
		})
	}
}
