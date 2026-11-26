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

// TestUpgradeSaysAnEstimateOfNoneAsNullInTheFeed: before version 31 a
// task's estimate of none was said as 0 in the feed's field changes (the
// engine of then wrote a cleared estimate "to": 0, and one set from none
// "from": 0). No 0 was an estimate then, so the upgrade says each as null,
// and leaves every other value, field and event as it was.
func TestUpgradeSaysAnEstimateOfNoneAsNullInTheFeed(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 30)
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
			project := do("project.create", map[string]any{"key": "SVA", "name": "Game"})
			task := do("task.create", map[string]any{"project": "SVA", "title": "Boss fight"})

			// Events as the engine of before wrote them (its patch.put of ints),
			// and one of another kind with a 0 in a field of the same name.
			const head = `{"changes":`
			tail := `,"id":"` + task + `","key":"SVA-1"}`
			before := []struct{ typ, data, want string }{
				{"task.updated", head + `{"estimate":{"from":0,"to":3}}` + tail, head + `{"estimate":{"from":null,"to":3}}` + tail},
				{"task.updated", head + `{"estimate":{"from":3,"to":5},"title":{"from":"Boss","to":"Boss fight"}}` + tail, ""},
				{"task.updated", head + `{"estimate":{"from":5,"to":0},"priority":{"from":0,"to":2}}` + tail, head + `{"estimate":{"from":5,"to":null},"priority":{"from":0,"to":2}}` + tail},
				{"task.updated", head + `{"priority":{"from":2,"to":0}}` + tail, ""},
				{"epic.updated", head + `{"estimate":{"from":0,"to":3}}` + tail, ""},
			}
			db := st.In(ws.ID)
			for i, ev := range before {
				if err := db.Insert(ctx, core.Event{WorkspaceID: ws.ID, Seq: int64(9000 + i), At: 1, ActorID: owner.ID, ChangeID: id.New(), Type: ev.typ,
					EntityType: "task", EntityID: task, ScopeType: "task", ScopeID: task, ProjectID: project, Data: json.RawMessage(ev.data)}); err != nil {
					t.Fatal(err)
				}
			}

			upgrade(t, st)
			for i, ev := range before {
				var got core.Event
				if err := db.Get(ctx, &got, store.Eq("seq", 9000+i)); err != nil {
					t.Fatal(err)
				}
				want := ev.want
				if want == "" {
					want = ev.data
				}
				var gotData, wantData any
				if err := json.Unmarshal(got.Data, &gotData); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal([]byte(want), &wantData); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(gotData, wantData) {
					t.Errorf("event %d after the upgrade:\n got  %s\n want %s", i, got.Data, want)
				}
			}
		})
	}
}
