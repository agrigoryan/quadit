package server_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestVault checks that an agent can use a secret and never get it back.
func TestVault(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		const key = "sk-live-9f3b7c21d4"
		var seen []string
		api := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			seen = append(seen, r.Method+" "+r.URL.Path+" auth="+r.Header.Get("Authorization")+" body="+string(body))
			switch r.URL.Path {
			case "/echo": // a careless service that says the key back
				rw.Header().Set("X-Debug", r.Header.Get("Authorization"))
				rw.Header().Set("Content-Type", "application/json")
				rw.Write([]byte(`{"you_sent":"` + r.Header.Get("Authorization") + `"}`))
			case "/away":
				http.Redirect(rw, r, "http://elsewhere.invalid/steal", http.StatusFound)
			default:
				rw.Header().Set("Content-Type", "application/json")
				rw.Write([]byte(`{"ok":true}`))
			}
		}))
		defer api.Close()
		other := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			t.Errorf("a secret was sent to a host it is not bound to: %s", r.Header.Get("Authorization"))
		}))
		defer other.Close()
		host := "http://" + strings.TrimPrefix(api.URL, "http://")

		s.change(s.owner, "", "agent.create", M{"name": "Coder", "handle": "coder"})
		s.change(s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var ct, at struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@coder"}, 201, &ct)
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &at)

		// Only an admin sets a secret; an agent cannot.
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": "secret.set", "args": M{"name": "DEPLOY_KEY", "value": "x"}}, 403, nil)
		s.change(s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "value": key, "description": "Deploys to staging", "hosts": []string{host}, "agents": []string{"@coder"}})

		if out := s.call(s.owner, "", "GET", w+"/audit?action=secret.set", nil, 200, nil); !strings.Contains(out, "DEPLOY_KEY") || !strings.Contains(out, "•••") {
			t.Fatalf("setting a secret is not on the record: %s", out)
		}
		// Other secrets given in a change are blanked on the record too.
		s.change(s.owner, "", "integration.create", M{"kind": "github", "secret": "ghp_integration_secret", "config": M{"repo": "a/b"}})
		s.change(s.owner, "", "webhook.create", M{"name": "hook", "url": api.URL + "/hook", "secret": "whsec_signing_secret"})
		for _, path := range []string{w + "/audit", "/api/v1/admin/audit", "/api/v1/admin/audit?format=csv"} {
			if out := s.call(s.owner, "", "GET", path, nil, 200, nil); strings.Contains(out, "ghp_integration_secret") || strings.Contains(out, "whsec_signing_secret") {
				t.Fatalf("%s holds a secret in plain text", path)
			}
		}
		// The value is nowhere: not in the list, the feed, the event, the bootstrap or the audit log.
		for _, path := range []string{w + "/secrets", w + "/list/secrets", w + "/events?limit=500", w + "/bootstrap", w + "/audit", "/api/v1/admin/audit"} {
			if out := s.call(s.owner, "", "GET", path, nil, 200, nil); strings.Contains(out, key) {
				t.Fatalf("%s shows the secret's value", path)
			}
		}
		if out := s.call(nil, ct.Token, "GET", "/api/v1/w/-/secrets?format=text", nil, 200, nil); !strings.Contains(out, "DEPLOY_KEY") || !strings.Contains(out, "Deploys to staging") {
			t.Fatalf("the agent's list of secrets: %s", out)
		}
		// An agent it is not for does not see it and cannot use it.
		if out := s.call(nil, at.Token, "GET", "/api/v1/w/-/secrets", nil, 200, nil); strings.Contains(out, "DEPLOY_KEY") {
			t.Fatalf("a secret shown to an agent it is not for: %s", out)
		}
		s.call(nil, at.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/deploy"}, 403, nil)

		// The agent uses it: the service gets the real key, the agent never does.
		var res struct {
			OK      bool
			Status  int
			Body    string
			Headers map[string]string
		}
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"method": "POST", "url": api.URL + "/deploy",
			"headers": M{"Authorization": "Bearer {{secret}}"}, "body": `{"ref":"main"}`}, 200, &res)
		if !res.OK || res.Status != 200 || len(seen) != 1 || !strings.Contains(seen[0], "auth=Bearer "+key) || !strings.Contains(seen[0], `body={"ref":"main"}`) {
			t.Fatalf("request with the secret: %+v, service saw %v", res, seen)
		}
		// A service that echoes the key: it is blanked in the body and the headers.
		raw := s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/echo", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, nil)
		if strings.Contains(raw, key) || !strings.Contains(raw, "Bearer •••") {
			t.Fatalf("an echoed secret came back: %s", raw)
		}
		// Not to another host, whatever the agent writes.
		for _, u := range []string{other.URL + "/x", "https://evil.example.com/?k={{secret}}", strings.Replace(api.URL, "127.0.0.1", "localhost", 1) + "/deploy"} {
			s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": u, "headers": M{"Authorization": "Bearer {{secret}}"}}, 403, nil)
		}
		// A redirect is not followed: the key stays with the host it was sent to.
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/away", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, &res)
		if res.Status != 302 {
			t.Fatalf("a redirect was followed: %+v", res)
		}
		// Every use is on the record, without the value.
		if out := s.call(s.owner, "", "GET", w+"/audit?action=secret.used", nil, 200, nil); strings.Count(out, "secret.used") < 3 || strings.Contains(out, key) || !strings.Contains(out, "/deploy") {
			t.Fatalf("audit of secret use: %s", out)
		}

		// The environment hand-off: only for secrets marked for it, and only
		// to a token an admin made for a companion.
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/env", M{"names": []string{"DEPLOY_KEY"}}, 403, nil)
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/tokens", M{"secrets": true}, 403, nil)
		var comp struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@coder", "name": "companion", "secrets": true}, 201, &comp)
		s.call(nil, comp.Token, "POST", "/api/v1/w/-/secrets/env", M{"names": []string{"DEPLOY_KEY"}}, 403, nil) // not marked env
		s.change(s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "env": true})
		var env struct{ Env map[string]string }
		s.call(nil, comp.Token, "POST", "/api/v1/w/-/secrets/env", M{"names": []string{"DEPLOY_KEY"}}, 200, &env)
		if env.Env["DEPLOY_KEY"] != key {
			t.Fatalf("the companion's environment: %v", env.Env)
		}

		// Changing the value keeps the rest; deleting wipes it.
		s.change(s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "value": "sk-live-rotated-77"})
		seen = nil
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/deploy", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, nil)
		if len(seen) != 1 || !strings.Contains(seen[0], "sk-live-rotated-77") {
			t.Fatalf("after rotating: %v", seen)
		}
		s.change(s.owner, "", "secret.delete", M{"id": "DEPLOY_KEY"})
		s.call(nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/deploy"}, 404, nil)
	})
}

// TestAgentsCannotWidenThemselves checks that an agent with limits cannot
// lift them, hand out more than it has, or point a cursor past the feed.
func TestAgentsCannotWidenThemselves(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		s.change(s.owner, "", "agent.create", M{"name": "Lead", "handle": "lead", "role": "admin", "scope": M{"projects": []string{"SVA"}, "needs_approval": []string{"project.delete"}}})
		s.change(s.owner, "", "agent.create", M{"name": "Wide", "handle": "wide", "role": "admin"})
		s.change(s.owner, "", "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}})
		var lead struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@lead"}, 201, &lead)
		try := func(typ string, args M, want int) string {
			return s.call(nil, lead.Token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": typ, "args": args}, want, nil)
		}
		// It cannot lift its own limits, by either door.
		try("agent.update", M{"id": "@lead", "scope": nil}, 403)
		try("agent.update", M{"id": "@lead", "scope": M{"projects": []string{"SVA", "OPS"}}}, 403)
		try("agent.update", M{"id": "@lead", "budget": M{"cost_micros": 999_000_000}}, 403)
		try("member.update", M{"id": "@lead", "role": "owner"}, 403)
		s.call(nil, lead.Token, "GET", "/api/v1/w/-/tasks/OPS-1", nil, 404, nil)
		// What it gives another agent is held to its own: asking for every
		// project gives its one project, with its approvals.
		try("agent.update", M{"id": "@narrow", "scope": nil}, 200)
		var list struct {
			Members []struct {
				Handle string
				Scope  *struct {
					Projects      []string
					NeedsApproval []string `json:"needs_approval"`
				}
			}
		}
		s.call(s.owner, "", "GET", w+"/list/members", nil, 200, &list)
		for _, m := range list.Members {
			if m.Handle == "narrow" && (m.Scope == nil || len(m.Scope.Projects) != 1 || len(m.Scope.NeedsApproval) != 1) {
				t.Fatalf("a limited agent lifted another agent's limits: %+v", m.Scope)
			}
		}
		// It cannot borrow a wider agent's access with a token.
		s.call(nil, lead.Token, "POST", "/api/v1/w/-/tokens", M{"user": "@wide"}, 403, nil)
		s.call(nil, lead.Token, "POST", "/api/v1/w/-/tokens", M{"user": "@narrow"}, 201, nil)
		// A cursor cannot be put past the end of the feed.
		s.call(nil, lead.Token, "PUT", "/api/v1/w/-/cursors/main", M{"seq": 999999}, 400, nil)
		s.call(nil, lead.Token, "PUT", "/api/v1/w/-/cursors/main", M{"seq": 3}, 200, nil)

		// A person can be limited to some projects too.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		mia := browser()
		s.call(mia, "", "POST", "/api/v1/auth/register", M{"name": "Mia", "email": "mia@example.com", "password": "another-long-password"}, 201, nil)
		s.change(s.owner, "", "member.add", M{"user": "mia@example.com", "scope": M{"projects": []string{"SVA"}}})
		s.call(mia, "", "GET", w+"/tasks/OPS-1", nil, 404, nil)
		if out := s.call(mia, "", "GET", w+"/bootstrap", nil, 200, nil); strings.Contains(out, "Rotate the keys") || strings.Contains(out, `"key":"OPS"`) {
			t.Fatal("a person limited to one project was sent another's")
		}
		s.call(mia, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "OPS", "title": "no"}}, 403, nil)
		s.change(s.owner, "", "member.update", M{"id": "@mia", "scope": nil})
		s.call(mia, "", "GET", w+"/tasks/OPS-1", nil, 200, nil)
	})
}

// TestSmallGuards covers a handful of refusals that keep people and agents
// out of trouble.
func TestSmallGuards(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "agent.create", M{"name": "Coder", "handle": "coder"})
		// A view is saved only with a filter that can be read.
		if out := s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Art", "query": M{"label": "art"}}}, 400, nil); !strings.Contains(out, "lists") {
			t.Fatalf("a view with a broken filter: %s", out)
		}
		s.change(s.owner, "", "view.create", M{"name": "Art", "query": M{"label": []string{"art"}}})
		// Turning passwords off with no other way in is refused.
		if out := s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.password", false, 409, nil); !strings.Contains(out, "no way to sign in") {
			t.Fatalf("locking oneself out: %s", out)
		}
		// The record says what a setting was changed to.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		if out := s.call(s.owner, "", "GET", "/api/v1/admin/audit?action=setting.changed", nil, 200, nil); !strings.Contains(out, `"value":true`) {
			t.Fatalf("audit of a setting: %s", out)
		}
		// A token's first use is on the record.
		var tok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@coder", "name": "ci"}, 201, &tok)
		s.call(nil, tok.Token, "GET", "/api/v1/w/-/me", nil, 200, nil)
		s.call(nil, tok.Token, "GET", "/api/v1/w/-/me", nil, 200, nil)
		if out := s.call(s.owner, "", "GET", w+"/audit?action=token.used", nil, 200, nil); strings.Count(out, `"token.used"`) != 1 {
			t.Fatalf("audit of token use: %s", out)
		}
		// A page built from the data mentions nobody.
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Fix the jump", "assignee": "@coder"})
		s.change(s.owner, "", "comment.create", M{"task": "SVA-1", "body": "@coder please look"})
		before := s.call(nil, tok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil)
		page := s.change(s.owner, "", "doc.create", M{"title": "Open questions", "generated": "open_questions"})["ref"].(string)
		s.call(nil, tok.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 200, nil)
		if after := s.call(nil, tok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil); after != before {
			t.Fatalf("a generated page wrote to someone's inbox:\n%s\n---\n%s", before, after)
		}
		// The metrics page is valid: one TYPE line per name.
		m := s.call(s.owner, "", "GET", "/metrics", nil, 200, nil)
		if strings.Count(m, "# TYPE quadit_rows ") != 1 {
			t.Fatalf("metrics: %s", m)
		}
	})
}
