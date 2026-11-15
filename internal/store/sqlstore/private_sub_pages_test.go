package sqlstore_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeMakesThePagesUnderAPrivatePagePrivate: a database from before
// version 8 can hold pages that stayed everyone's under a page made private
// after them. The upgrade gives each the owner and the sharing of the
// nearest private page above it, and search keeps them, the comments on
// them and the private page itself to their readers. A page under it that
// someone keeps private on their own stays theirs.
func TestUpgradeMakesThePagesUnderAPrivatePagePrivate(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openAtVersion(t, d, 7)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			do := func(actor, typ string, args map[string]any) string {
				t.Helper()
				raw, _ := json.Marshal(args)
				res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: actor}, engine.Change{ID: id.New(), Type: typ, Args: raw})
				if err != nil {
					t.Fatalf("%s: %v", typ, err)
				}
				return res.Ref
			}
			other := do(owner.ID, "agent.create", map[string]any{"name": "Other", "handle": "other"})
			bea := do(owner.ID, "agent.create", map[string]any{"name": "Bea", "handle": "bea"})
			root := do(owner.ID, "doc.create", map[string]any{"title": "Plans", "markdown": "quokka\n"})
			child := do(owner.ID, "doc.create", map[string]any{"parent": root, "title": "Quarter one", "markdown": "quokka\n"})
			grand := do(owner.ID, "doc.create", map[string]any{"parent": child, "title": "Week one", "markdown": "quokka\n"})
			do(owner.ID, "comment.create", map[string]any{"doc": grand, "body": "wombat"})
			gone := do(owner.ID, "doc.create", map[string]any{"parent": child, "title": "Old week"})
			do(owner.ID, "doc.delete", map[string]any{"id": gone})
			beas := do(bea, "doc.create", map[string]any{"parent": root, "title": "Bea's", "private": true})
			beasChild := do(bea, "doc.create", map[string]any{"parent": beas, "title": "Bea's child"})
			// What doc.update did before: the page alone, its search entry as it was.
			if err := st.Exec(ctx, fmt.Sprintf(`UPDATE docs SET owner_id = '%s', shared_with = '["%s"]' WHERE id = '%s'`, owner.ID, bea, root)); err != nil {
				t.Fatal(err)
			}

			if err := st.MigrateTo(ctx, 0); err != nil {
				t.Fatal(err)
			}
			db := st.In(ws.ID)
			for _, page := range []string{root, child, grand, gone} {
				var doc core.Doc
				if err := db.Get(ctx, &doc, store.Eq("id", page)); err != nil {
					t.Fatal(err)
				}
				if doc.OwnerID != owner.ID || !slices.Equal(doc.SharedWith, []string{bea}) {
					t.Errorf("%s after the upgrade: owner %q, shared with %v; want the private page's", doc.Title, doc.OwnerID, doc.SharedWith)
				}
			}
			for _, page := range []string{beas, beasChild} {
				var doc core.Doc
				if err := db.Get(ctx, &doc, store.Eq("id", page)); err != nil {
					t.Fatal(err)
				}
				if doc.OwnerID != bea {
					t.Errorf("%s, Bea's own, now belongs to %q", doc.Title, doc.OwnerID)
				}
			}
			finds := func(viewer, text string) []string {
				hits, err := db.Search(ctx, store.SearchQuery{Text: text, Viewer: viewer})
				if err != nil {
					t.Fatal(err)
				}
				var pages []string
				for _, h := range hits {
					pages = append(pages, h.ScopeID)
				}
				slices.Sort(pages)
				return pages
			}
			if got := finds(other, "quokka"); len(got) != 0 {
				t.Errorf("another member finds %v by search, want none of the private pages", got)
			}
			if got := finds(other, "wombat"); len(got) != 0 {
				t.Errorf("another member finds the comment on a private sub-page: %v", got)
			}
			want := []string{root, child, grand}
			slices.Sort(want)
			if got := finds(owner.ID, "quokka"); !slices.Equal(got, want) {
				t.Errorf("the owner finds %v, want %v", got, want)
			}
		})
	}
}

// openAtVersion opens an empty database of a kind at a schema version,
// standing in for an older binary's.
func openAtVersion(t *testing.T, d sqlstore.Dialect, version int) *sqlstore.Store {
	t.Helper()
	var db *sql.DB
	var err error
	switch d.Name {
	case sqlstore.SQLite.Name:
		db, err = sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "quadit.sqlite")+"?_pragma=foreign_keys(1)")
	default:
		url := os.Getenv("QUADIT_TEST_POSTGRES")
		if url == "" {
			t.Skip("QUADIT_TEST_POSTGRES is not set")
		}
		schema := fmt.Sprintf("t%d", time.Now().UnixNano())
		admin, err := sql.Open("pgx", url)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`); err != nil {
				t.Logf("schema %s is left behind: %v", schema, err)
			}
			admin.Close()
		})
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		db, err = sql.Open("pgx", url+sep+"search_path="+schema)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	st := sqlstore.New(db, d)
	t.Cleanup(func() { st.Close() })
	if err := st.MigrateTo(context.Background(), version); err != nil {
		t.Fatal(err)
	}
	return st
}
