package sqlstore_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeKeepsHandoffLimitsAndDropsWhatAgentsSpent: until version 12
// an agent and a task had a budget (money, minutes, hand-offs) and a
// session kept what it cost. The upgrade keeps the hand-offs as the
// hand-off limit, on the row and in the feed, and takes out the rest: the
// columns, the inbox warnings with their events, and what the feed said of
// money, tokens and time, dropping an event that said nothing else.
//
// The rows are written as version 11 wrote them, in its SQL: this
// version's code no longer writes a budget.
func TestUpgradeKeepsHandoffLimitsAndDropsWhatAgentsSpent(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openAtVersion(t, d, 11)
			ws, person, agent, project, status := id.New(), id.New(), id.New(), id.New(), id.New()
			limited, costOnly, child, session := id.New(), id.New(), id.New(), id.New()
			warning, assigned := id.New(), id.New()
			exec := func(query string, args ...any) {
				t.Helper()
				if err := st.Exec(ctx, fmt.Sprintf(query, args...)); err != nil {
					t.Fatalf("%s: %v", query, err)
				}
			}
			exec(`INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES ('%s', 'games', 'Games', 1, 1)`, ws)
			exec(`INSERT INTO users (id, kind, name, email, created_at, updated_at) VALUES ('%s', 'person', 'Aram', 'aram@example.com', 1, 1)`, person)
			exec(`INSERT INTO users (id, kind, name, workspace_id, responsible_id, created_at, updated_at) VALUES ('%s', 'agent', 'Artist', '%s', '%s', 1, 1)`, agent, ws, person)
			member := `INSERT INTO members (workspace_id, user_id, role, handle, kind, name, budget, created_at, updated_seq) VALUES ('%s', '%s', '%s', '%s', '%s', '%s', %s, 1, 1)`
			exec(member, ws, person, "owner", "aram", "person", "Aram", "NULL")
			exec(member, ws, agent, "member", "artist", "agent", "Artist", `'{"cost_micros":5000000,"minutes":600,"handoffs":3}'`)
			exec(`INSERT INTO projects (id, workspace_id, key, name, created_by, created_at, updated_at, created_seq, updated_seq) VALUES ('%s', '%s', 'SVA', 'Samurai', '%s', 1, 1, 1, 1)`, project, ws, person)
			exec(`INSERT INTO statuses (id, workspace_id, project_id, name, category, rank, is_default, created_at, updated_seq) VALUES ('%s', '%s', '%s', 'Todo', 'unstarted', 'a', TRUE, 1, 1)`, status, ws, project)
			task := `INSERT INTO tasks (id, workspace_id, project_id, number, key, title, status_id, parent_id, budget, rank, created_by, created_at, updated_at, created_seq, updated_seq, activity_seq)
				VALUES ('%s', '%s', '%s', %d, 'SVA-%d', '%s', '%s', %s, %s, 'a', '%s', 1, 1, 1, 1, 1)`
			exec(task, limited, ws, project, 1, 1, "Draw the boss", status, "NULL", `'{"cost_micros":1000000,"handoffs":2}'`, person)
			exec(task, costOnly, ws, project, 2, 2, "Paint the sky", status, "NULL", `'{"minutes":60}'`, person)
			exec(task, child, ws, project, 3, 3, "Forge the sword", status, "'"+limited+"'", "NULL", person)
			exec(`INSERT INTO agent_sessions (id, workspace_id, agent_id, task_id, title, cost_micros, tokens_in, tokens_out, started_at, updated_seq) VALUES ('%s', '%s', '%s', '%s', 'Drawing', 1250000, 900, 300, 1, 1)`, session, ws, agent, limited)
			note := `INSERT INTO notifications (id, workspace_id, user_id, seq, type, actor_id, title, created_at) VALUES ('%s', '%s', '%s', %d, '%s', '%s', '%s', 1)`
			exec(note, warning, ws, person, 1, "budget", agent, "SVA-1 has used 80% of its budget")
			exec(note, assigned, ws, person, 2, "assigned", agent, "Draw the boss")
			seq := 0
			event := func(typ, entityType, entityID, data string) {
				t.Helper()
				seq++
				exec(`INSERT INTO events (workspace_id, seq, at, actor_id, change_id, type, entity_type, entity_id, scope_type, scope_id, data) VALUES ('%s', %d, 1, '%s', '%s', '%s', '%s', '%s', 'workspace', '%s', '%s')`,
					ws, seq, person, id.New(), typ, entityType, entityID, ws, data)
			}
			event("notification.created", "notification", warning, `{"row":{"id":"`+warning+`","type":"budget"}}`)
			event("notification.created", "notification", assigned, `{"row":{"id":"`+assigned+`","type":"assigned"}}`)
			event("task.created", "task", limited, `{"row":{"id":"`+limited+`","title":"Draw the boss","budget":{"cost_micros":1000000,"handoffs":2}}}`)
			event("task.created", "task", costOnly, `{"row":{"id":"`+costOnly+`","title":"Paint the sky","budget":{"minutes":60}}}`)
			event("task.updated", "task", limited, `{"id":"`+limited+`","changes":{"title":{"from":"Boss","to":"Draw the boss"},"budget":{"from":null,"to":{"cost_micros":1000000,"handoffs":2}}}}`)
			event("task.updated", "task", costOnly, `{"id":"`+costOnly+`","changes":{"budget":{"from":null,"to":{"minutes":60}}}}`)
			event("member.updated", "member", agent, `{"id":"`+agent+`","changes":{"budget":{"from":{"handoffs":1},"to":{"cost_micros":5000000,"minutes":600,"handoffs":3}}}}`)
			event("session.updated", "session", session, `{"id":"`+session+`","changes":{"cost_micros":{"from":0,"to":1250000},"state":{"from":"running","to":"done"}}}`)
			event("session.updated", "session", session, `{"id":"`+session+`","changes":{"tokens_in":{"from":0,"to":900},"tokens_out":{"from":0,"to":300}}}`)

			if err := st.MigrateTo(ctx, 0); err != nil {
				t.Fatal(err)
			}
			db := st.In(ws)

			t.Run("the hand-offs of a budget are the hand-off limit", func(t *testing.T) {
				limits := map[string]int{}
				var members []core.Member
				if err := db.List(ctx, &members, store.Q{}); err != nil {
					t.Fatal(err)
				}
				for _, m := range members {
					limits["@"+m.Handle] = m.HandoffLimit
				}
				var tasks []core.Task
				if err := db.List(ctx, &tasks, store.Q{}); err != nil {
					t.Fatal(err)
				}
				for _, task := range tasks {
					limits[task.Key] = task.HandoffLimit
					if task.Key == "SVA-3" && task.ParentID != limited {
						t.Errorf("SVA-3's parent is %q after the upgrade, want SVA-1", task.ParentID)
					}
					if task.Key == "SVA-1" && (task.Title != "Draw the boss" || task.StatusID != status || task.CreatedBy != person) {
						t.Errorf("SVA-1 lost what it had: %+v", task)
					}
				}
				want := map[string]int{"@aram": 0, "@artist": 3, "SVA-1": 2, "SVA-2": 0, "SVA-3": 0}
				if fmt.Sprint(limits) != fmt.Sprint(want) {
					t.Errorf("hand-off limits %v, want %v", limits, want)
				}
			})

			t.Run("what was spent is gone", func(t *testing.T) {
				for _, column := range []string{"members.budget", "tasks.budget", "agent_sessions.cost_micros", "agent_sessions.tokens_in", "agent_sessions.tokens_out"} {
					table, col, _ := strings.Cut(column, ".")
					if err := st.Exec(ctx, "SELECT "+col+" FROM "+table); err == nil {
						t.Errorf("%s is still there", column)
					}
				}
				var run core.AgentSession
				if err := db.Get(ctx, &run, store.Eq("id", session)); err != nil || run.Title != "Drawing" || run.TaskID != limited {
					t.Errorf("the session is %+v (%v), want it kept as it was", run, err)
				}
				var notes []core.Notification
				if err := db.List(ctx, &notes, store.Q{}); err != nil {
					t.Fatal(err)
				}
				if len(notes) != 1 || notes[0].ID != assigned {
					t.Errorf("the inbox holds %+v, want only the assignment", notes)
				}
			})

			t.Run("the feed says the same", func(t *testing.T) {
				evs, err := db.Events(ctx, store.EventFilter{Limit: 100})
				if err != nil {
					t.Fatal(err)
				}
				var got []string
				for _, ev := range evs {
					var data any
					if err := json.Unmarshal(ev.Data, &data); err != nil {
						t.Fatal(err)
					}
					// The ids differ from run to run; what is said of them does not.
					line := strings.NewReplacer(warning, "warning", assigned, "assigned", limited, "SVA-1", costOnly, "SVA-2", agent, "artist", session, "session").
						Replace(string(mustJSON(t, data)))
					got = append(got, ev.Type+" "+line)
				}
				want := []string{
					`notification.created {"row":{"id":"assigned","type":"assigned"}}`,
					`task.created {"row":{"handoff_limit":2,"id":"SVA-1","title":"Draw the boss"}}`,
					`task.created {"row":{"id":"SVA-2","title":"Paint the sky"}}`,
					`task.updated {"changes":{"handoff_limit":{"from":0,"to":2},"title":{"from":"Boss","to":"Draw the boss"}},"id":"SVA-1"}`,
					`member.updated {"changes":{"handoff_limit":{"from":1,"to":3}},"id":"artist"}`,
					`session.updated {"changes":{"state":{"from":"running","to":"done"}},"id":"session"}`,
				}
				if strings.Join(got, "\n") != strings.Join(want, "\n") {
					t.Errorf("the feed after the upgrade:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
				}
			})
		})
	}
}

// mustJSON is v as JSON, its keys in order.
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
