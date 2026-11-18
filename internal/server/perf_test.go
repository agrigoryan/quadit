package server_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestSpeedAtTenThousandTasks checks the promise that the server answers
// quickly with 10,000 tasks in a workspace. It takes a while to fill the
// database, so it runs only when asked for:
//
//	QUADIT_PERF=1 go test -run TestSpeed -v ./internal/server
func TestSpeedAtTenThousandTasks(t *testing.T) {
	if os.Getenv("QUADIT_PERF") == "" {
		t.Skip("set QUADIT_PERF=1 to run")
	}
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		s.change(s.owner, "", "label.create", M{"name": "art", "project": "SVA"})
		statuses := []string{"Backlog", "Todo", "In Progress", "Waiting", "Done"}
		start := time.Now()
		for batch := range 20 {
			var changes []M
			for i := range 500 {
				n := batch*500 + i
				args := M{"project": "SVA", "title": fmt.Sprintf("Task number %d about sprites and explosions", n), "status": statuses[n%5],
					"description": "Some words to search for: alien samurai boss fight.", "priority": n % 5}
				if n%3 == 0 {
					args["assignee"] = "@artist"
					args["labels"] = []string{"art"}
				}
				changes = append(changes, M{"id": id.New(), "type": "task.create", "args": args})
			}
			s.call(s.owner, "", "POST", w+"/changes", M{"changes": changes}, 200, nil)
		}
		t.Logf("%s: made 10,000 tasks in %s", st.Dialect(), time.Since(start).Round(time.Millisecond))

		var tok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
		timed := func(what string, limit time.Duration, fn func()) {
			t.Helper()
			fn() // once to warm up
			best := time.Hour
			for range 5 {
				at := time.Now()
				fn()
				if d := time.Since(at); d < best {
					best = d
				}
			}
			t.Logf("%s: %-34s %s", st.Dialect(), what, best.Round(100*time.Microsecond))
			if best > limit {
				t.Errorf("%s took %s, over the %s it should stay under", what, best, limit)
			}
		}
		get := func(path string) func() {
			return func() { s.call(nil, tok.Token, "GET", "/api/v1/w/-"+path, nil, 200, nil) }
		}
		const fast = 100 * time.Millisecond
		timed("my work", fast, get("/my-work?format=text"))
		timed("tasks assigned to me, open", fast, get("/tasks?assignee=me&open=1&sort=priority&format=text"))
		timed("count by status", fast, get("/tasks?status=waiting&count=1"))
		timed("one task", fast, get("/tasks/SVA-5000?format=text"))
		timed("context pack", fast, get("/tasks/SVA-5000/context?format=text"))
		timed("search", fast, get("/search?q=explosions&format=text"))
		timed("feed from a position", fast, get("/events?after=9000&limit=100&format=text"))
		timed("feed for my tasks", fast, get("/events?after=9000&mine=1&limit=100&format=text"))
		timed("one change", fast, func() {
			s.change(nil, tok.Token, "comment.create", M{"task": "SVA-5000", "body": "a comment"})
		})
		timed("dashboard", 500*time.Millisecond, get("/dashboard"))
		// The web app's starting copy is everything at once; it is read once
		// per session, so it may take longer than a single answer.
		timed("bootstrap (whole workspace)", 1500*time.Millisecond, func() { s.call(s.owner, "", "GET", w+"/bootstrap", nil, 200, nil) })
	})
}

// TestSpeedOfADatabaseWhoseRowsLinkManyRows checks that the cells of a
// database are worked out in time proportional to the links they follow:
// a relation, a formula reading it and a rollup over it, on 400 rows that
// each link the same 400 rows of another database. Gated like the test
// above:
//
//	QUADIT_PERF=1 go test -run TestSpeedOfADatabase -v ./internal/server
func TestSpeedOfADatabaseWhoseRowsLinkManyRows(t *testing.T) {
	if os.Getenv("QUADIT_PERF") == "" {
		t.Skip("set QUADIT_PERF=1 to run")
	}
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		do := func(typ string, args M) string { return s.change(s.owner, "", typ, args)["ref"].(string) }
		const n = 400
		servers := do("doc.create", M{"title": "Servers", "kind": "database", "project": "SVA"})
		do("property.create", M{"database": servers, "name": "Load", "type": "number"})
		create := func(args func(i int) M) []string {
			var ids []string
			var changes []M
			for i := range n {
				a := args(i)
				a["id"] = id.New()
				ids = append(ids, a["id"].(string))
				changes = append(changes, M{"id": id.New(), "type": "doc.create", "args": a})
			}
			s.call(s.owner, "", "POST", w+"/changes", M{"changes": changes}, 200, nil)
			return ids
		}
		linked := create(func(i int) M {
			return M{"parent": servers, "title": fmt.Sprintf("server-%d", i), "props": M{"Load": i}}
		})
		sprites := do("doc.create", M{"title": "Sprites", "kind": "database", "project": "SVA"})
		do("property.create", M{"database": sprites, "name": "Server", "type": "relation", "config": M{"database": servers}})
		do("property.create", M{"database": sprites, "name": "Where", "type": "formula", "config": M{"formula": `length(prop("Server"))`}})
		do("property.create", M{"database": sprites, "name": "Total", "type": "rollup", "config": M{"relation": "Server", "target": "Load", "fn": "sum"}})
		create(func(i int) M {
			return M{"parent": sprites, "title": fmt.Sprintf("sprite-%d", i), "props": M{"Server": linked}}
		})

		s.call(s.owner, "", "GET", w+"/docs/"+sprites+"/rows", nil, 200, nil) // once to warm up
		at := time.Now()
		out := s.call(s.owner, "", "GET", w+"/docs/"+sprites+"/rows", nil, 200, nil)
		took := time.Since(at)
		t.Logf("%s: %d rows linking %d rows each: %s", st.Dialect(), n, n, took.Round(time.Millisecond))
		if !strings.Contains(out, fmt.Sprint(n*(n-1)/2)) {
			t.Fatalf("the rollup does not sum the linked rows: %.300s", out)
		}
		if limit := 500 * time.Millisecond; took > limit {
			t.Errorf("the rows took %s, over the %s they should stay under", took, limit)
		}
	})
}
