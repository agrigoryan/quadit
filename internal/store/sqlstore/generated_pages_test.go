package sqlstore_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeTakesOutWhatWasStoredOfPagesBuiltFromData: until version 9 a
// page built from data (a decision log, a changelog) was written into the
// page by whoever read it first, with what that reader might see, for
// everyone. The upgrade takes that out of the page, of search, of what
// the page mentions, of its versions and of its events in the feed; the
// page itself stays, found by its title, and a page people wrote keeps
// everything.
func TestUpgradeTakesOutWhatWasStoredOfPagesBuiltFromData(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openAtVersion(t, d, 0) // the rows as version 8 left them: see upgradeRows
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
			do("project.create", map[string]any{"key": "OPS", "name": "Operations"})
			task := do("task.create", map[string]any{"project": "OPS", "title": "Rotate keys"})
			written := do("doc.create", map[string]any{"title": "Handbook", "markdown": "quokka, see OPS-1\n"})
			log := do("doc.create", map[string]any{"title": "Decision log", "generated": "decision_log"})
			// What reading the page did before: the server wrote it, and kept
			// in the page when.
			err = e.System(ctx, ws.ID, owner.ID, func(sys *engine.Sys) error {
				for _, change := range []struct {
					typ  string
					args map[string]any
				}{
					{"doc.write", map[string]any{"doc": log, "markdown": "- **OPS-1** Which wombat? → **Plains**\n"}},
					{"doc.snapshot", map[string]any{"doc": log, "label": "kept"}},
					{"doc.snapshot", map[string]any{"doc": written, "label": "kept"}},
				} {
					if err := sys.Do(change.typ, change.args); err != nil {
						return err
					}
				}
				_, err := sys.Tx().Update(ctx, "docs", map[string]any{"props": json.RawMessage(`{"built_seq":7}`)}, store.Eq("id", log))
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			db := st.In(ws.ID)
			stored := func(page string) (blocks, versions, mentions int, feed string, props string) {
				t.Helper()
				var bl []core.Block
				var vs []core.DocVersion
				var refs []core.Ref
				var doc core.Doc
				for _, read := range []error{
					db.List(ctx, &bl, store.Where(store.Eq("doc_id", page))),
					db.List(ctx, &vs, store.Where(store.Eq("doc_id", page))),
					db.List(ctx, &refs, store.Where(store.Eq("from_id", page))),
					db.Get(ctx, &doc, store.Eq("id", page)),
				} {
					if read != nil {
						t.Fatal(read)
					}
				}
				evs, err := db.Events(ctx, store.EventFilter{ScopeType: "doc", ScopeID: page, Limit: 100})
				if err != nil {
					t.Fatal(err)
				}
				for _, ev := range evs {
					feed += ev.Type + " " + string(ev.Data) + "\n"
				}
				return len(bl), len(vs), len(refs), feed, string(doc.Props)
			}
			finds := func(text string) []string {
				t.Helper()
				hits, err := db.Search(ctx, store.SearchQuery{Text: text, Viewer: owner.ID})
				if err != nil {
					t.Fatal(err)
				}
				var pages []string
				for _, h := range hits {
					pages = append(pages, h.ScopeID)
				}
				return pages
			}
			if blocks, versions, mentions, feed, _ := stored(log); blocks == 0 || versions == 0 || mentions == 0 || !strings.Contains(feed, "wombat") || len(finds("wombat")) != 1 {
				t.Fatalf("before the upgrade the page built from data holds %d blocks, %d versions, %d mentions, is found by its text %d times, and its feed is: %s",
					blocks, versions, mentions, len(finds("wombat")), feed)
			}

			upgradeRows(t, st, 8)
			blocks, versions, mentions, feed, props := stored(log)
			if blocks != 0 || versions != 0 || mentions != 0 || strings.Contains(feed, "wombat") || strings.Contains(props, "built_seq") {
				t.Errorf("after the upgrade the page built from data still holds %d blocks, %d versions, %d mentions, props %s, and its feed is: %s", blocks, versions, mentions, props, feed)
			}
			if !strings.Contains(feed, "doc.created") || !strings.Contains(feed, "doc.edited") {
				t.Errorf("the page's events are gone from the feed, not emptied: %s", feed)
			}
			if got := finds("wombat"); len(got) != 0 {
				t.Errorf("search still finds the page built from data by what was stored in it: %v", got)
			}
			if got := finds("decision log"); len(got) != 1 || got[0] != log {
				t.Errorf("search finds %v by the page's title, want the page", got)
			}
			var tk core.Task
			if err := db.Get(ctx, &tk, store.Eq("id", task)); err != nil || tk.Key != "OPS-1" {
				t.Fatalf("the task: %+v, %v", tk, err)
			}
			// A page people wrote is as it was.
			if blocks, versions, mentions, feed, _ := stored(written); blocks != 1 || versions != 1 || mentions != 1 || !strings.Contains(feed, "quokka") || len(finds("quokka")) != 1 {
				t.Errorf("a written page lost something in the upgrade: %d blocks, %d versions, %d mentions, found %d times, feed: %s", blocks, versions, mentions, len(finds("quokka")), feed)
			}
		})
	}
}
