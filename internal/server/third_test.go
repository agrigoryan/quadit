package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestThirdAuditFindings holds what a third independent check of the build
// found, each as the smallest case that showed it.
func TestThirdAuditFindings(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		for _, h := range []string{"wide", "narrow"} {
			s.change(s.owner, "", "agent.create", M{"name": h, "handle": h})
		}
		tok := func(h string) string {
			var out struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@" + h}, 201, &out)
			return out.Token
		}
		do := func(token, typ string, args any, want int) string {
			return s.call(nil, token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": typ, "args": args}, want, nil)
		}
		wide := tok("wide")

		// A part of an agent's limits that an update leaves out stays.
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"projects": []string{"OPS"}, "read_only": true, "needs_approval": []string{"task.delete"}}})
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"needs_approval": []string{"task.move"}}})
		out := s.call(s.owner, "", "GET", w+"/list/members", nil, 200, nil)
		if !strings.Contains(out, `"read_only":true`) || !strings.Contains(out, `"needs_approval":["task.move"]`) || strings.Contains(out, "task.delete") {
			t.Fatalf("a partial update of limits did not keep the rest: %s", out)
		}
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"read_only": false}})
		narrow := tok("narrow")
		if out := s.call(nil, narrow, "GET", "/api/v1/w/-/list/projects", nil, 200, nil); strings.Contains(out, "Samurai") {
			t.Fatalf("lifting read-only lifted the project limit too: %s", out)
		}
		// A person's limits with nothing in them is no limit, not a crash.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		mia := browser()
		s.call(mia, "", "POST", "/api/v1/auth/register", M{"name": "Mia", "email": "mia@example.com", "password": "another-long-password"}, 201, nil)
		s.change(s.owner, "", "member.add", M{"user": "mia@example.com"})
		s.change(s.owner, "", "member.update", M{"id": "@mia", "scope": M{}})
		s.call(mia, "", "GET", w+"/tasks/OPS-1", nil, 200, nil)

		// Limited to one project: nothing of another's shows through.
		s.change(s.owner, "", "epic.create", M{"project": "SVA", "name": "Boss fight"})
		s.change(s.owner, "", "milestone.create", M{"epic": "Boss fight", "name": "Alpha"})
		var f struct{ ID string }
		s.call(s.owner, "", "POST", w+"/files?name=secret.txt", []byte("for SVA eyes"), 201, &f)
		s.change(s.owner, "", "attachment.add", M{"task": "SVA-1", "file": f.ID})
		do(wide, "session.start", M{"task": "SVA-1", "title": "Drawing the secret boss"}, 200)
		do(wide, "comment.create", M{"task": "SVA-1", "body": "On it."}, 200)
		s.call(nil, narrow, "GET", "/api/v1/w/-/files/"+f.ID, nil, 404, nil)
		for _, path := range []string{"/bootstrap", "/list/milestones", "/list/members", "/agents", "/dashboard", "/list/sessions"} {
			out := s.call(nil, narrow, "GET", "/api/v1/w/-"+path, nil, 200, nil)
			for _, leak := range []string{"secret boss", "Alpha", "SVA-1"} {
				if strings.Contains(out, leak) {
					t.Fatalf("%s shows %q to an agent limited to OPS: %s", path, leak, out)
				}
			}
		}

		// A helper does not make helpers; a suspended one is not "idle".
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": nil})
		do(wide, "agent.create", M{"name": "Helper", "handle": "helper", "task": "OPS-1"}, 200)
		helper := tok("helper")
		if out := do(helper, "agent.create", M{"name": "Nested", "handle": "nested", "task": "OPS-1"}, 403); !strings.Contains(out, "cannot make helpers") {
			t.Fatalf("a helper made a helper: %s", out)
		}
		s.change(s.owner, "", "task.update", M{"id": "OPS-1", "status": "Done"})
		if out := s.call(s.owner, "", "GET", w+"/agents", nil, 200, nil); strings.Contains(out, "@helper") {
			t.Fatalf("a suspended helper is listed among the agents at work: %s", out)
		}

		// The text line of a standing preference carries its text.
		s.change(s.owner, "", "preference.create", M{"body": "Explosions are always ring-shaped"})
		if out := s.call(s.owner, "", "GET", w+"/list/preferences?format=text", nil, 200, nil); !strings.Contains(out, "ring-shaped") {
			t.Fatalf("a preference's line has no text: %s", out)
		}

		// A moved task is still found under the key it had.
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Moves away"})
		moved := s.change(s.owner, "", "task.move", M{"id": "SVA-2", "project": "OPS"})["key"].(string)
		if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-2", nil, 200, nil); !strings.Contains(out, moved) {
			t.Fatalf("SVA-2 does not lead to %s: %s", moved, out)
		}
		do(wide, "comment.create", M{"task": "SVA-2", "body": "Found by the old key."}, 200)

		// An import keeps a task's number; the next task made goes past it.
		do(wide, "task.create", M{"project": "SVA", "title": "Not for a member", "number": 40}, 403)
		if key := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "From elsewhere", "number": 40})["key"]; key != "SVA-40" {
			t.Fatalf("number 40 gave %v", key)
		}
		s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Twice", "number": 40}}, 409, nil)
		s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Was moved", "number": 2}}, 409, nil)
		if key := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "The next one"})["key"]; key != "SVA-41" {
			t.Fatalf("the task after number 40 is %v", key)
		}
		if key := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Into a gap", "number": 7})["key"]; key != "SVA-7" {
			t.Fatalf("number 7 gave %v", key)
		}

		// A saved view names only what exists; one whose label was deleted
		// since is read without that part, and says so.
		s.change(s.owner, "", "label.create", M{"project": "SVA", "name": "zed"})
		for _, q := range []M{{"label": []string{"nope"}}, {"status": []string{"Nope"}}, {"sort": "bogus"}} {
			if out := s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Bad", "query": q}}, 400, nil); strings.Contains(out, "Go ") {
				t.Fatalf("a view with %v: %s", q, out)
			}
		}
		s.change(s.owner, "", "view.create", M{"name": "Zed things", "project": "SVA", "query": M{"label": []string{"zed"}}})
		res := s.change(s.owner, "", "label.delete", M{"id": "zed"})
		if key, _ := res["key"].(string); strings.HasPrefix(key, "SVA-") {
			t.Fatalf("label.delete answered with a task key: %v", res)
		}
		if out := s.call(s.owner, "", "GET", w+"/tasks?view=zed-things&format=text", nil, 200, nil); !strings.Contains(out, "no longer exists") || !strings.Contains(out, "SVA-1") {
			t.Fatalf("a view whose label is gone: %s", out)
		}

		// A list read page by page while a task's place in it changes: none is missed.
		for i := 0; i < 6; i++ {
			s.change(s.owner, "", "task.create", M{"project": "OPS", "title": fmt.Sprintf("Ordered %d", i), "priority": 3})
		}
		type page struct {
			Tasks      []struct{ Key string }
			NextCursor string `json:"next_cursor"`
			NextOffset *int   `json:"next_offset"`
		}
		var p page
		s.call(s.owner, "", "GET", w+"/tasks?project=OPS&open=1&sort=priority&limit=3", nil, 200, &p)
		seen := map[string]bool{}
		for _, tk := range p.Tasks {
			seen[tk.Key] = true
		}
		var all page
		s.call(s.owner, "", "GET", w+"/tasks?project=OPS&open=1&sort=priority&limit=50", nil, 200, &all)
		last := all.Tasks[len(all.Tasks)-1].Key
		s.change(s.owner, "", "task.update", M{"id": last, "priority": "urgent"}) // jumps behind the reader
		for p.NextCursor != "" {
			cur := p.NextCursor
			p = page{}
			s.call(s.owner, "", "GET", w+"/tasks?project=OPS&open=1&sort=priority&limit=3&cursor="+cur, nil, 200, &p)
			if p.NextOffset != nil {
				t.Fatal("a page read by cursor still offers an offset")
			}
			for _, tk := range p.Tasks {
				seen[tk.Key] = true
			}
		}
		for _, tk := range all.Tasks {
			if !seen[tk.Key] {
				t.Fatalf("%s was never returned (raised: %s)", tk.Key, last)
			}
		}

		// Settings: a cleared limit applies at once, a tiny one is refused,
		// and null on a sign-in setting means its default.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/limits.api_per_minute", json.RawMessage("-5"), 400, nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/limits.api_per_minute", json.RawMessage("30"), 200, nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/limits.api_per_minute", json.RawMessage("null"), 200, nil)
		if f := s.srv.LimitFactor(); f != 1 {
			t.Fatalf("after clearing the limit the factor is %v", f)
		}
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.password", json.RawMessage("null"), 200, nil)

		// Messages speak of fields, not of the decoder.
		for _, c := range []struct {
			typ  string
			args any
		}{{"task.update", M{"id": "SVA-1", "priority": 1.5}}, {"task.update", []string{"SVA-1"}}, {"view.create", M{"name": "V", "query": M{"label": "art"}}}} {
			out := do(wide, c.typ, c.args, 400)
			if strings.Contains(out, "Go ") || strings.Contains(out, "unmarshal") || strings.Contains(out, ":  takes") {
				t.Fatalf("%s %v: %s", c.typ, c.args, out)
			}
		}
		if out := s.call(nil, wide, "PUT", "/api/v1/w/-/cursors/x", M{"seq": "a"}, 400, nil); strings.Contains(out, "Go ") {
			t.Fatalf("a cursor of the wrong kind: %s", out)
		}
		if out := s.call(nil, wide, "GET", "/api/v1/w/-/me?format=text", nil, 200, nil); strings.Contains(out, "map[") {
			t.Fatalf("me prints a Go map: %s", out)
		}

		// What a change wrote for someone else alone does not come back to its sender.
		out = s.call(s.owner, "", "POST", w+"/changes?events=1", M{"id": id.New(), "type": "comment.create", "args": M{"task": "SVA-1", "body": "@wide look"}}, 200, nil)
		if strings.Contains(out, "notification.created") {
			t.Fatalf("the sender got the other member's notice: %s", out)
		}

		// A push subscription is taken as browsers send it, with its
		// (empty) expiry: a real phone's was refused for that field.
		s.call(s.owner, "", "POST", "/api/v1/push/subscriptions", json.RawMessage(`{"endpoint":"https://fcm.googleapis.com/fcm/send/abc","expirationTime":null,"keys":{"p256dh":"BPk","auth":"x1"}}`), 201, nil)

		// A call to MCP with no token at all is counted like a wrong one.
		limited := false
		for i := 0; i < 140 && !limited; i++ {
			resp, err := http.Post(s.url+"/mcp", "application/json", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			limited = resp.StatusCode == 429
			resp.Body.Close()
		}
		if !limited {
			t.Fatal("140 calls with no token were never slowed down")
		}
	})
}
