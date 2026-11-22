package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestRowsMadeInTheSameMillisecondComeInOneOrder: links, sessions, tokens
// and what mentions a page are listed by when they were made, or by
// nothing; rows of the same moment come in the order of their ids, not in
// the order the database happens to hold them.
func TestRowsMadeInTheSameMillisecondComeInOneOrder(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		ctx := context.Background()
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		task := s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})["ref"].(string)
		target := s.change(t, s.owner, "", "doc.create", M{"title": "Target"})["ref"].(string)
		from := s.change(t, s.owner, "", "doc.create", M{"title": "From"})["ref"].(string)
		wsID, owner := siteWorkspaceID(t, st), s.ownerID(t)
		db := st.In(wsID)
		// Ids that sort the other way from the order the rows are written in.
		ids := []string{"01a1e100-0000-7000-8000-000000000003", "01a1e100-0000-7000-8000-000000000002", "01a1e100-0000-7000-8000-000000000001"}
		want := slices.Sorted(slices.Values(ids))
		const at = int64(1_700_000_000_000)
		for i, rowID := range ids {
			for _, row := range []any{
				core.APIToken{ID: rowID, WorkspaceID: wsID, UserID: owner, Name: "t", TokenHash: rowID, Prefix: "qd_", Kind: core.TokenAPI, CreatedBy: owner, CreatedAt: at},
				core.TaskLink{ID: rowID, WorkspaceID: wsID, TaskID: task, Kind: core.LinkURL, URL: fmt.Sprintf("https://example.com/%d", i), CreatedBy: owner, CreatedAt: at, UpdatedAt: at},
				core.AgentSession{ID: rowID, WorkspaceID: wsID, AgentID: owner, TaskID: task, State: core.AgentSessionDone, StartedAt: at},
				core.Ref{WorkspaceID: wsID, FromType: "block", FromID: rowID, FromScopeType: "doc", FromScopeID: from, ToType: "doc", ToID: target},
			} {
				if err := db.Insert(ctx, row); err != nil {
					t.Fatal(err)
				}
			}
		}
		listed := func(path, field, key string) []string {
			t.Helper()
			var out map[string]json.RawMessage
			s.call(t, s.owner, "", "GET", w+path, nil, 200, &out)
			var rows []map[string]any
			if err := json.Unmarshal(out[field], &rows); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, row := range rows {
				if v, _ := row[key].(string); slices.Contains(ids, v) {
					got = append(got, v)
				}
			}
			return got
		}
		for _, c := range []struct{ what, path, field, key string }{
			{"tokens", "/tokens", "tokens", "id"},
			{"links", "/list/links?task=SVA-1", "links", "id"},
			{"sessions", "/list/sessions?task=SVA-1", "sessions", "id"},
			{"what mentions a page", "/docs/" + target, "mentioned_in", "from_id"},
		} {
			if got := listed(c.path, c.field, c.key); !slices.Equal(got, want) {
				raw, _ := json.Marshal(got)
				t.Errorf("%s of the same moment come as %s, want by id", c.what, raw)
			}
		}
	})
}
