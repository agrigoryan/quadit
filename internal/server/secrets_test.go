package server_test

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/cli"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestVault checks that an agent can use a secret and never get it back.
func TestVault(t *testing.T) {
	t.Parallel()
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

		// Coder is trusted to send with secrets without asking first (a new
		// agent asks before a request that changes something).
		s.change(t, s.owner, "", "agent.create", M{"name": "Coder", "handle": "coder", "scope": M{"needs_approval": []string{}}})
		s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var ct, at struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@coder"}, 201, &ct)
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &at)

		// Only an admin sets a secret; an agent cannot.
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": "secret.set", "args": M{"name": "DEPLOY_KEY", "value": "x"}}, 403, nil)
		s.change(t, s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "value": key, "description": "Deploys to staging", "hosts": []string{host}, "agents": []string{"@coder"}})

		if out := s.call(t, s.owner, "", "GET", w+"/audit?action=secret.set", nil, 200, nil); !strings.Contains(out, "DEPLOY_KEY") || !strings.Contains(out, "•••") {
			t.Fatalf("setting a secret is not on the record: %s", out)
		}
		// Other secrets given in a change are blanked on the record too.
		s.change(t, s.owner, "", "integration.create", M{"kind": "github", "secret": "ghp_integration_secret", "config": M{"repo": "a/b"}})
		// The webhook's deliveries go to a receiver of their own: the service
		// counts only what the secret's requests send it.
		s.change(t, s.owner, "", "webhook.create", M{"name": "hook", "url": newReceiver(t, "").srv.URL, "secret": "whsec_signing_secret"})
		for _, path := range []string{w + "/audit", "/api/v1/admin/audit", "/api/v1/admin/audit?format=csv"} {
			if out := s.call(t, s.owner, "", "GET", path, nil, 200, nil); strings.Contains(out, "ghp_integration_secret") || strings.Contains(out, "whsec_signing_secret") {
				t.Fatalf("%s holds a secret in plain text", path)
			}
		}
		// The value is nowhere: not in the list, the feed, the event, the bootstrap or the audit log.
		for _, path := range []string{w + "/secrets", w + "/list/secrets", w + "/events?limit=500", w + "/bootstrap", w + "/audit", "/api/v1/admin/audit"} {
			if out := s.call(t, s.owner, "", "GET", path, nil, 200, nil); strings.Contains(out, key) {
				t.Fatalf("%s shows the secret's value", path)
			}
		}
		if out := s.call(t, nil, ct.Token, "GET", "/api/v1/w/-/secrets?format=text", nil, 200, nil); !strings.Contains(out, "DEPLOY_KEY") || !strings.Contains(out, "Deploys to staging") {
			t.Fatalf("the agent's list of secrets: %s", out)
		}
		// An agent it is not for does not see it and cannot use it.
		if out := s.call(t, nil, at.Token, "GET", "/api/v1/w/-/secrets", nil, 200, nil); strings.Contains(out, "DEPLOY_KEY") {
			t.Fatalf("a secret shown to an agent it is not for: %s", out)
		}
		s.call(t, nil, at.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/deploy"}, 403, nil)

		// The agent uses it: the service gets the real key, the agent never does.
		var res struct {
			OK      bool
			Status  int
			Body    string
			Headers map[string]string
		}
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"method": "POST", "url": api.URL + "/deploy",
			"headers": M{"Authorization": "Bearer {{secret}}"}, "body": `{"ref":"main"}`}, 200, &res)
		if !res.OK || res.Status != 200 || len(seen) != 1 || !strings.Contains(seen[0], "auth=Bearer "+key) || !strings.Contains(seen[0], `body={"ref":"main"}`) {
			t.Fatalf("request with the secret: %+v, service saw %v", res, seen)
		}
		// A service that echoes the key: it is blanked in the body and the headers.
		raw := s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/echo", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, nil)
		if strings.Contains(raw, key) || !strings.Contains(raw, "Bearer •••") {
			t.Fatalf("an echoed secret came back: %s", raw)
		}
		// Not to another host, whatever the agent writes.
		for _, u := range []string{other.URL + "/x", "https://evil.example.com/?k={{secret}}", strings.Replace(api.URL, "127.0.0.1", "localhost", 1) + "/deploy"} {
			s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": u, "headers": M{"Authorization": "Bearer {{secret}}"}}, 403, nil)
		}
		// A redirect is not followed: the key stays with the host it was sent to.
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/away", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, &res)
		if res.Status != 302 {
			t.Fatalf("a redirect was followed: %+v", res)
		}
		// Header names are not case-sensitive: one named twice, in two cases,
		// is refused, not sent with one of its values picked by chance.
		before := len(seen)
		twice := M{"url": api.URL + "/deploy", "headers": M{"Authorization": "Bearer {{secret}}", "authorization": "Basic {{basic:bot}}"}}
		if out := s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", twice, 400, nil); !strings.Contains(out, `\"Authorization\" and \"authorization\"`) || len(seen) != before {
			t.Fatalf("a header named twice: %s; the service saw %v", out, seen[before:])
		}
		// Every use is on the record, without the value.
		if out := s.call(t, s.owner, "", "GET", w+"/audit?action=secret.used", nil, 200, nil); strings.Count(out, "secret.used") < 3 || strings.Contains(out, key) || !strings.Contains(out, "/deploy") {
			t.Fatalf("audit of secret use: %s", out)
		}

		// The environment hand-off: only for secrets marked for it, and only
		// to a token an admin made for a companion.
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/env", M{"names": []string{"DEPLOY_KEY"}}, 403, nil)
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/tokens", M{"secrets": true}, 403, nil)
		var comp struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@coder", "name": "companion", "secrets": true}, 201, &comp)
		s.call(t, nil, comp.Token, "POST", "/api/v1/w/-/secrets/env", M{"names": []string{"DEPLOY_KEY"}}, 403, nil) // not marked env
		s.change(t, s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "env": true})
		var env struct{ Env map[string]string }
		s.call(t, nil, comp.Token, "POST", "/api/v1/w/-/secrets/env", M{"names": []string{"DEPLOY_KEY"}}, 200, &env)
		if env.Env["DEPLOY_KEY"] != key {
			t.Fatalf("the companion's environment: %v", env.Env)
		}

		// Changing the value keeps the rest; deleting wipes it.
		s.change(t, s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "value": "sk-live-rotated-77"})
		seen = nil
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/deploy", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, nil)
		if len(seen) != 1 || !strings.Contains(seen[0], "sk-live-rotated-77") {
			t.Fatalf("after rotating: %v", seen)
		}
		s.change(t, s.owner, "", "secret.delete", M{"id": "DEPLOY_KEY"})
		s.call(t, nil, ct.Token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", M{"url": api.URL + "/deploy"}, 404, nil)
	})
}

// TestAgentsCannotWidenThemselves checks that an agent with limits cannot
// lift them, hand out more than it has, or point a cursor past the feed.
func TestAgentsCannotWidenThemselves(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Lead", "handle": "lead", "role": "admin", "scope": M{"projects": []string{"SVA"}, "needs_approval": []string{"project.delete"}}})
		s.change(t, s.owner, "", "agent.create", M{"name": "Wide", "handle": "wide", "role": "admin"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}})
		var lead struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@lead"}, 201, &lead)
		try := func(typ string, args M, want int) string {
			return s.call(t, nil, lead.Token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": typ, "args": args}, want, nil)
		}
		// It cannot lift its own limits, by either door.
		try("agent.update", M{"id": "@lead", "scope": nil}, 403)
		try("agent.update", M{"id": "@lead", "scope": M{"projects": []string{"SVA", "OPS"}}}, 403)
		try("agent.update", M{"id": "@lead", "handoff_limit": 0}, 403)
		try("member.update", M{"id": "@lead", "role": "owner"}, 403)
		s.call(t, nil, lead.Token, "GET", "/api/v1/w/-/tasks/OPS-1", nil, 404, nil)
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
		s.call(t, s.owner, "", "GET", w+"/list/members", nil, 200, &list)
		for _, m := range list.Members {
			if m.Handle == "narrow" && (m.Scope == nil || len(m.Scope.Projects) != 1 || len(m.Scope.NeedsApproval) != 1) {
				t.Fatalf("a limited agent lifted another agent's limits: %+v", m.Scope)
			}
		}
		// It cannot borrow a wider agent's access with a token.
		s.call(t, nil, lead.Token, "POST", "/api/v1/w/-/tokens", M{"user": "@wide"}, 403, nil)
		s.call(t, nil, lead.Token, "POST", "/api/v1/w/-/tokens", M{"user": "@narrow"}, 201, nil)
		// A cursor cannot be put past the end of the feed.
		s.call(t, nil, lead.Token, "PUT", "/api/v1/w/-/cursors/main", M{"seq": 999999}, 400, nil)
		s.call(t, nil, lead.Token, "PUT", "/api/v1/w/-/cursors/main", M{"seq": 3}, 200, nil)

		// A person can be limited to some projects too.
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		mia := browser()
		s.call(t, mia, "", "POST", "/api/v1/auth/register", M{"name": "Mia", "email": "mia@example.com", "password": "another-long-password"}, 201, nil)
		s.change(t, s.owner, "", "member.add", M{"user": "mia@example.com", "scope": M{"projects": []string{"SVA"}}})
		s.call(t, mia, "", "GET", w+"/tasks/OPS-1", nil, 404, nil)
		if out := s.call(t, mia, "", "GET", w+"/bootstrap", nil, 200, nil); strings.Contains(out, "Rotate the keys") || strings.Contains(out, `"key":"OPS"`) {
			t.Fatal("a person limited to one project was sent another's")
		}
		s.call(t, mia, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "OPS", "title": "no"}}, 403, nil)
		s.change(t, s.owner, "", "member.update", M{"id": "@mia", "scope": nil})
		s.call(t, mia, "", "GET", w+"/tasks/OPS-1", nil, 200, nil)
	})
}

// TestSmallGuards covers a handful of refusals that keep people and agents
// out of trouble.
func TestSmallGuards(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Coder", "handle": "coder"})
		// A view is saved only with a filter that can be read.
		if out := s.call(t, s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Art", "query": M{"label": "art"}}}, 400, nil); !strings.Contains(out, "lists") {
			t.Fatalf("a view with a broken filter: %s", out)
		}
		s.change(t, s.owner, "", "label.create", M{"project": "SVA", "name": "art"})
		s.change(t, s.owner, "", "view.create", M{"name": "Art", "query": M{"label": []string{"art"}}})
		// Turning passwords off with no other way in is refused.
		if out := s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth.password", false, 409, nil); !strings.Contains(out, "no way to sign in") {
			t.Fatalf("locking oneself out: %s", out)
		}
		// The record says what a setting was changed to.
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		if out := s.call(t, s.owner, "", "GET", "/api/v1/admin/audit?action=setting.changed", nil, 200, nil); !strings.Contains(out, `"value":true`) {
			t.Fatalf("audit of a setting: %s", out)
		}
		// A token's first use is on the record.
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@coder", "name": "ci"}, 201, &tok)
		s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/me", nil, 200, nil)
		s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/me", nil, 200, nil)
		if out := s.call(t, s.owner, "", "GET", w+"/audit?action=token.used", nil, 200, nil); strings.Count(out, `"token.used"`) != 1 {
			t.Fatalf("audit of token use: %s", out)
		}
		// A page built from the data mentions nobody.
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Fix the jump", "assignee": "@coder"})
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "@coder please look"})
		before := s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil)
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Open questions", "generated": "open_questions"})["ref"].(string)
		s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 200, nil)
		if after := s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil); after != before {
			t.Fatalf("a generated page wrote to someone's inbox:\n%s\n---\n%s", before, after)
		}
		// The metrics page is valid: one TYPE line per name.
		m := s.call(t, s.owner, "", "GET", "/metrics", nil, 200, nil)
		if strings.Count(m, "# TYPE quadit_rows ") != 1 {
			t.Fatalf("metrics: %s", m)
		}
		// With a token set, the page takes that token and no other.
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/metrics.token", "scrape-secret", 200, nil)
		s.call(t, &http.Client{}, "scrape-secre", "GET", "/metrics", nil, 401, nil)
		s.call(t, &http.Client{}, "scrape-secret", "GET", "/metrics", nil, 200, nil)
	})
}

// TestDeleteWorkspace checks that an owner can delete a workspace, that it
// can be brought back for a while, and that afterwards nothing of it is left.
func TestDeleteWorkspace(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Stays"})
		var made struct{ ID, Slug string }
		s.call(t, s.owner, "", "POST", "/api/v1/workspaces", M{"name": "Side project", "slug": "side"}, 201, &made)
		side := "/api/v1/w/side"
		do := func(typ string, args M) map[string]any {
			var out map[string]any
			s.call(t, s.owner, "", "POST", side+"/changes", M{"id": id.New(), "type": typ, "args": args}, 200, &out)
			return out
		}
		do("project.create", M{"key": "SP", "name": "Side"})
		do("agent.create", M{"name": "Helper", "handle": "helper"})
		do("task.create", M{"project": "SP", "title": "Goes away", "assignee": "@helper"})
		do("comment.create", M{"task": "SP-1", "body": "words"})
		do("decision.open", M{"task": "SP-1", "question": "Which?", "options": []M{{"label": "A"}, {"label": "B"}}})
		do("doc.create", M{"title": "Notes", "markdown": "some notes\n"})
		do("webhook.create", M{"name": "hook", "url": "http://127.0.0.1:1/x"})
		do("secret.set", M{"name": "KEY", "value": "v-123456", "hosts": []string{"example.com"}})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", side+"/tokens", M{"user": "@helper"}, 201, &tok)
		var f struct{ ID string }
		s.call(t, nil, tok.Token, "POST", "/api/v1/w/-/files?name=a.txt", []byte("file body"), 201, &f)

		// Only with its name, only by its owner.
		s.call(t, s.owner, "", "POST", side+"/changes", M{"id": id.New(), "type": "workspace.delete", "args": M{"confirm": "nope"}}, 400, nil)
		s.call(t, nil, tok.Token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": "workspace.delete", "args": M{"confirm": "side"}}, 403, nil)
		do("workspace.delete", M{"confirm": "side"})
		s.call(t, s.owner, "", "GET", side+"/me", nil, 404, nil)
		s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/me", nil, 404, nil)
		if out := s.call(t, s.owner, "", "GET", "/api/v1/admin/workspaces", nil, 200, nil); !strings.Contains(out, `"deleted_at"`) {
			t.Fatalf("a deleted workspace is not listed for the install admin: %s", out)
		}
		// It can come back.
		s.call(t, s.owner, "", "POST", "/api/v1/admin/workspaces/"+made.ID+"/restore", nil, 200, nil)
		if out := s.call(t, s.owner, "", "GET", side+"/tasks/SP-1", nil, 200, nil); !strings.Contains(out, "Goes away") {
			t.Fatalf("a restored workspace: %s", out)
		}
		// Deleted again and a month on, nothing of it is left; the other is whole.
		do("workspace.delete", M{"confirm": "side"})
		prefixes, err := s.srv.Engine().PurgeWorkspaces(context.Background(), -time.Hour)
		if err != nil || len(prefixes) != 1 {
			t.Fatalf("purge: %v %v", prefixes, err)
		}
		for _, table := range []string{"tasks", "comments", "decisions", "docs", "doc_blocks", "events", "members", "webhooks", "secrets", "api_tokens", "files"} {
			if n, _ := st.Count(context.Background(), table, store.Eq("workspace_id", made.ID)); n != 0 {
				t.Errorf("%d rows left in %s", n, table)
			}
		}
		if n, _ := st.Count(context.Background(), "workspaces", store.Eq("id", made.ID)); n != 0 {
			t.Error("the workspace row is still there")
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, nil); !strings.Contains(out, "Stays") {
			t.Fatalf("the other workspace: %s", out)
		}
	})
}

// TestCheapReads checks that list reads take a field selector and a
// "changed since" form.
func TestCheapReads(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss"})
		s.change(t, s.owner, "", "decision.open", M{"task": "SVA-1", "question": "Old question?", "options": []M{{"label": "A"}, {"label": "B"}}})
		s.change(t, s.owner, "", "doc.create", M{"title": "Old page", "markdown": "x\n"})
		var me struct{ Seq int64 }
		s.call(t, s.owner, "", "GET", w+"/me", nil, 200, &me)
		mark := fmt.Sprint(me.Seq)
		s.change(t, s.owner, "", "decision.open", M{"task": "SVA-1", "question": "New question?", "options": []M{{"label": "A"}, {"label": "B"}}})
		s.change(t, s.owner, "", "doc.create", M{"title": "New page", "markdown": "y\n"})
		s.change(t, s.owner, "", "label.create", M{"project": "SVA", "name": "fresh"})
		for path, want := range map[string][2]string{
			w + "/decisions?state=all&since=" + mark:             {"New question?", "Old question?"},
			w + "/decisions?state=all&format=text&since=" + mark: {"New question?", "Old question?"},
			w + "/docs?since=" + mark:                            {"New page", "Old page"},
			w + "/docs?format=text&since=" + mark:                {"New page", "Old page"},
			w + "/list/labels?since=" + mark:                     {"fresh", "bug"},
		} {
			if out := s.call(t, s.owner, "", "GET", path, nil, 200, nil); !strings.Contains(out, want[0]) || strings.Contains(out, want[1]) {
				t.Errorf("%s: %.300s", path, out)
			}
		}
		// Only the fields asked for, and the id.
		out := s.call(t, s.owner, "", "GET", w+"/docs?fields=title", nil, 200, nil)
		if !strings.Contains(out, `"title":"New page"`) || !strings.Contains(out, `"id"`) || strings.Contains(out, "updated_seq") || strings.Contains(out, "created_by") {
			t.Errorf("fields on docs: %.300s", out)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/decisions?state=all&fields=question,state", nil, 200, nil); !strings.Contains(out, `"question"`) || strings.Contains(out, `"options"`) {
			t.Errorf("fields on decisions: %.300s", out)
		}
		// Plain lists have a text form.
		if out := s.call(t, s.owner, "", "GET", w+"/list/statuses?format=text", nil, 200, nil); !strings.Contains(out, "Todo") || !strings.Contains(out, "id=") || strings.Contains(out, "{") {
			t.Errorf("statuses as text: %.300s", out)
		}
	})
}

// TestNamesNotIDs checks that an agent can say what it means by name.
func TestNamesNotIDs(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "epic.create", M{"project": "SVA", "name": "Boss fight"})
		s.change(t, s.owner, "", "milestone.create", M{"epic": "Boss fight", "name": "Alpha"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design", "epic": "Boss fight", "milestone": "Alpha", "priority": "high"})
		s.change(t, s.owner, "", "task.update", M{"id": "SVA-1", "milestone": "alpha", "priority": "urgent"})
		if out := s.call(t, s.owner, "", "GET", w+"/tasks?priority=urgent&format=text", nil, 200, nil); !strings.Contains(out, "SVA-1") {
			t.Fatalf("tasks by priority name: %s", out)
		}
		out := s.call(t, s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.update", "args": M{"id": "SVA-1", "priority": "hihg"}}, 400, nil)
		if !strings.Contains(out, `"nearest":"high"`) || !strings.Contains(out, "urgent") {
			t.Fatalf("a misspelled priority: %s", out)
		}
		s.call(t, s.owner, "", "GET", w+"/tasks?priority=hihg", nil, 400, nil)
		// A decision by its task; with two, by its number. An agent asks, the owner answers.
		s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var art struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &art)
		s.change(t, nil, art.Token, "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "options": []M{{"label": "Ring"}, {"label": "Burst"}}})
		s.change(t, s.owner, "", "decision.pick", M{"id": "SVA-1", "option": "2"})
		s.change(t, nil, art.Token, "decision.open", M{"task": "SVA-1", "question": "Which color?", "options": []M{{"label": "Red"}, {"label": "Blue"}}})
		s.change(t, nil, art.Token, "decision.open", M{"task": "SVA-1", "question": "Which sound?", "options": []M{{"label": "Boom"}, {"label": "Zap"}}})
		if out := s.call(t, s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "decision.pick", "args": M{"id": "SVA-1", "option": "1"}}, 400, nil); !strings.Contains(out, "SVA-1#") {
			t.Fatalf("two open decisions and no number: %s", out)
		}
		s.change(t, s.owner, "", "decision.pick", M{"id": "SVA-1#3", "option": "Zap"})
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil); !strings.Contains(out, "Burst") || !strings.Contains(out, "Zap") {
			t.Fatalf("picks made by task key: %s", out)
		}
		// Watching an epic and a view by name.
		s.change(t, s.owner, "", "view.create", M{"name": "Urgent things", "query": M{"priority": []int{1}}})
		s.change(t, s.owner, "", "watch.set", M{"type": "epic", "subject": "Boss fight"})
		s.change(t, s.owner, "", "watch.set", M{"type": "view", "subject": "Urgent things"})
		// A name nothing has says which names there are.
		if out := s.call(t, s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "watch.set", "args": M{"type": "epic", "subject": "Bos fight"}}, 404, nil); !strings.Contains(out, `"nearest":"Boss fight"`) {
			t.Fatalf("a misspelled epic: %s", out)
		}
	})
}

// TestRestoreAFile checks that a removed file can be put back.
func TestRestoreAFile(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		var f struct{ ID, URL string }
		s.call(t, s.owner, "", "POST", w+"/files?name=sketch.txt", []byte("a sketch"), 201, &f)
		att := s.change(t, s.owner, "", "attachment.add", M{"task": "SVA-1", "file": f.ID})["ref"].(string)
		path := strings.TrimPrefix(f.URL, s.url)
		s.change(t, s.owner, "", "attachment.remove", M{"id": att})
		s.call(t, s.owner, "", "GET", path, nil, 404, nil)
		if out := s.call(t, s.owner, "", "GET", w+"/list/attachments?trash=1", nil, 200, nil); !strings.Contains(out, "sketch.txt") {
			t.Fatalf("removed files are not listed: %s", out)
		}
		s.change(t, s.owner, "", "attachment.restore", M{"id": att})
		if out := s.call(t, s.owner, "", "GET", path, nil, 200, nil); out != "a sketch" {
			t.Fatalf("a restored file reads %q", out)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, nil); !strings.Contains(out, "sketch.txt") {
			t.Fatalf("a restored file is not back on its task: %s", out)
		}
	})
}

// TestSubAgents checks delegation: an agent makes a helper for one task,
// which is held to that task's project and ends with the task.
func TestSubAgents(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Draw the boss"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var art struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &art)
		do := func(token, typ string, args M, want int) string {
			return s.call(t, nil, token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": typ, "args": args}, want, nil)
		}
		// A member agent cannot make a standing agent, but can make a helper for a task.
		if out := do(art.Token, "agent.create", M{"name": "Standing", "handle": "standing"}, 403); !strings.Contains(out, "sub-agent") {
			t.Fatalf("a member making a standing agent: %s", out)
		}
		do(art.Token, "agent.create", M{"name": "Inker", "handle": "inker", "task": "SVA-1", "role": "admin"}, 403)
		do(art.Token, "agent.create", M{"name": "Inker", "handle": "inker", "task": "SVA-1", "description": "Inks the boss frames"}, 200)
		var ink struct{ Token string }
		s.call(t, nil, art.Token, "POST", "/api/v1/w/-/tokens", M{"user": "@inker"}, 201, &ink)
		// The helper works on its task's project and nowhere else.
		do(ink.Token, "comment.create", M{"task": "SVA-1", "body": "Frames inked."}, 200)
		s.call(t, nil, ink.Token, "GET", "/api/v1/w/-/tasks/OPS-1", nil, 404, nil)
		if out := s.call(t, nil, ink.Token, "GET", "/api/v1/w/-/me?format=text", nil, 200, nil); !strings.Contains(out, "@inker") {
			t.Fatalf("the helper is: %s", out)
		}
		// It has its own name on what it does, and the same person answers for it.
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil); !strings.Contains(out, "@inker") {
			t.Fatalf("the helper's comment: %s", out)
		}
		// The task is done: the helper is finished, and its token with it.
		s.change(t, s.owner, "", "task.update", M{"id": "SVA-1", "status": "done"})
		s.call(t, nil, ink.Token, "GET", "/api/v1/w/-/me", nil, 401, nil)
		var list struct {
			Members []struct {
				Handle      string
				SuspendedAt int64  `json:"suspended_at"`
				Delegated   string `json:"delegated_by"`
			}
		}
		s.call(t, s.owner, "", "GET", w+"/list/members", nil, 200, &list)
		for _, m := range list.Members {
			if m.Handle == "inker" && (m.SuspendedAt == 0 || m.Delegated == "") {
				t.Fatalf("the helper after its task closed: %+v", m)
			}
		}
	})
}

// TestSurfaceOnlyGrows holds the agent-facing surface to its promise: what
// an agent was built against yesterday still works today. The change types
// with their arguments, the API's paths and the MCP tools with theirs are
// written in testdata/surface.txt; anything there that the code no longer
// has fails the test. Something new is added to the file by running the
// test with QUADIT_UPDATE_SURFACE=1, which never removes a line: taking one
// out is a breaking change, made by hand together with a new major version
// of engine.Surface.
func TestSurfaceOnlyGrows(t *testing.T) {
	t.Parallel()
	var now []string
	for _, ci := range engine.Catalog() {
		now = append(now, "change "+ci.Type)
		for _, a := range ci.Args {
			now = append(now, "change "+ci.Type+" arg "+a.Name)
		}
	}
	s := newSite(t, testdb.SQLite(t))
	var spec struct {
		Paths map[string]map[string]any
	}
	s.call(t, nil, "", "GET", "/api/v1/openapi.json", nil, 200, &spec)
	for path, methods := range spec.Paths {
		for method := range methods {
			now = append(now, "api "+strings.ToUpper(method)+" "+path)
		}
	}
	resp, err := http.Post(s.url+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	if err != nil {
		t.Fatal(err)
	}
	var tools struct {
		Result struct {
			Tools []struct {
				Name        string
				InputSchema struct {
					Properties map[string]any
				} `json:"inputSchema"`
			}
		}
		Error any
	}
	json.NewDecoder(resp.Body).Decode(&tools)
	resp.Body.Close()
	if len(tools.Result.Tools) == 0 {
		// The list needs a token; ask with one.
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{}, 201, &tok)
		req, _ := http.NewRequest(http.MethodPost, s.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		req.Header.Set("Authorization", "Bearer "+tok.Token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		json.NewDecoder(resp.Body).Decode(&tools)
		resp.Body.Close()
	}
	for _, tool := range tools.Result.Tools {
		now = append(now, "mcp "+tool.Name)
		for arg := range tool.InputSchema.Properties {
			now = append(now, "mcp "+tool.Name+" arg "+arg)
		}
	}
	// The command-line tool's commands, as its own table lists them.
	cmds := 0
	for _, name := range cli.Commands() {
		now = append(now, "cli "+name)
		cmds++
	}
	if cmds < 20 {
		t.Fatalf("could not read the command-line tool's commands: %d", cmds)
	}
	if len(tools.Result.Tools) < 10 || len(spec.Paths) < 10 {
		t.Fatalf("could not read the surface: %d tools, %d paths", len(tools.Result.Tools), len(spec.Paths))
	}
	sort.Strings(now)
	have := map[string]bool{}
	for _, l := range now {
		have[l] = true
	}
	const file = "testdata/surface.txt"
	raw, _ := os.ReadFile(file)
	var kept, missing []string
	known := map[string]bool{}
	for l := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		kept, known[l] = append(kept, l), true
		if !have[l] {
			missing = append(missing, l)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("the agent surface lost %d things it promised (surface %s):\n  %s\nPut them back, or make it a new major version on purpose.", len(missing), engine.Surface, strings.Join(missing, "\n  "))
	}
	var added []string
	for _, l := range now {
		if !known[l] {
			added = append(added, l)
		}
	}
	if len(added) == 0 {
		return
	}
	if os.Getenv("QUADIT_UPDATE_SURFACE") == "" {
		t.Fatalf("the agent surface gained %d things not yet written down:\n  %s\nRun the test once with QUADIT_UPDATE_SURFACE=1 to record them.", len(added), strings.Join(added, "\n  "))
	}
	all := append(kept, added...)
	sort.Strings(all)
	head := "# What agents are built against, surface " + strings.Split(engine.Surface, ".")[0] + ".x. Lines are only ever added here.\n"
	if err := os.WriteFile(file, []byte(head+strings.Join(all, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestImportThroughTheAPI checks that an export uploaded to the server can
// be imported there, as the web app does it.
func TestImportThroughTheAPI(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		csv := "\ufeffID,Team,Title,Description,Status,Estimate,Priority,Project,Assignee,Labels,Due Date,Parent issue,Completed,Canceled\n" +
			"ENG-1,Eng,Login page,\"Build the **login** page\",In Review,3,High,Onboarding,aram,\"bug, frontend\",2026-12-01,,,\n" +
			"ENG-2,Eng,Password field,,Done,1,No priority,Onboarding,someone.else@example.com,,,ENG-1,2026-11-01,\n"
		var f struct{ ID string }
		s.call(t, s.owner, "", "POST", w+"/files?name=linear.csv", []byte(csv), 201, &f)
		var res struct {
			Found, Made     map[string]int
			UnmatchedPeople []string `json:"unmatched_people"`
			DryRun          bool     `json:"dry_run"`
		}
		// A look first: what is in it, with nothing written.
		s.call(t, s.owner, "", "POST", w+"/import", M{"kind": "linear", "file": f.ID, "options": M{"project": "eng"}, "dry_run": true}, 200, &res)
		if res.Found["tasks"] != 2 || !res.DryRun {
			t.Fatalf("a look at the export: %+v", res)
		}
		s.call(t, s.owner, "", "GET", w+"/tasks/ENG-1", nil, 404, nil)
		s.call(t, s.owner, "", "POST", w+"/import", M{"kind": "linear", "file": f.ID, "options": M{"project": "eng"}}, 200, &res)
		if res.Made["tasks"] != 2 || len(res.UnmatchedPeople) != 1 {
			t.Fatalf("the import: %+v", res)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks?project=ENG&format=text", nil, 200, nil); !strings.Contains(out, "Login page") || !strings.Contains(out, "Password field") {
			t.Fatalf("imported tasks: %s", out)
		}
		// Again: nothing twice, and the answer says so.
		res.Made = nil
		s.call(t, s.owner, "", "POST", w+"/import", M{"kind": "linear", "file": f.ID, "options": M{"project": "eng"}}, 200, &res)
		if res.Made["tasks"] != 0 {
			t.Fatalf("a second run says it made %d tasks", res.Made["tasks"])
		}
		var n struct{ Count int }
		s.call(t, s.owner, "", "GET", w+"/tasks?project=ENG&count=1", nil, 200, &n)
		if n.Count != 2 {
			t.Fatalf("a second run made %d tasks in all", n.Count)
		}
		// Not for members, and not with a file that is something else.
		s.change(t, s.owner, "", "agent.create", M{"name": "Coder", "handle": "coder"})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@coder"}, 201, &tok)
		s.call(t, nil, tok.Token, "POST", "/api/v1/w/-/import", M{"kind": "linear", "file": f.ID}, 403, nil)
		s.call(t, s.owner, "", "POST", w+"/files?name=notes.json", []byte("not a board"), 201, &f)
		s.call(t, s.owner, "", "POST", w+"/import", M{"kind": "trello", "file": f.ID, "options": M{"project": "T"}}, 400, nil)
	})
}

// TestPagesDoNotShift checks paging by cursor: a task added between two
// pages neither repeats one nor skips one.
func TestPagesDoNotShift(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		for i := 1; i <= 7; i++ {
			s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": fmt.Sprintf("Task %d", i)})
		}
		type page struct {
			Tasks      []struct{ Key string }
			NextCursor string `json:"next_cursor"`
		}
		seen := map[string]int{}
		var p page
		s.call(t, s.owner, "", "GET", w+"/tasks?sort=-created&limit=3", nil, 200, &p)
		for round := 0; ; round++ {
			for _, tk := range p.Tasks {
				seen[tk.Key]++
			}
			if p.NextCursor == "" {
				break
			}
			// Someone adds a task while the list is being read.
			s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Added meanwhile"})
			next := p.NextCursor
			p = page{}
			s.call(t, s.owner, "", "GET", w+"/tasks?sort=-created&limit=3&cursor="+next, nil, 200, &p)
			if round > 10 {
				t.Fatal("paging never ends")
			}
		}
		if len(seen) != 7 {
			t.Fatalf("read %d different tasks, want the 7 that were there: %v", len(seen), seen)
		}
		for key, n := range seen {
			if n != 1 {
				t.Fatalf("%s came %d times", key, n)
			}
		}
		// A task on the first page is closed before the second is read: the
		// rest still come, each once.
		read := func(query string, between func()) map[string]int {
			got := map[string]int{}
			var p page
			s.call(t, s.owner, "", "GET", w+"/tasks?"+query, nil, 200, &p)
			for round := range 20 {
				for _, tk := range p.Tasks {
					got[tk.Key]++
				}
				if p.NextCursor == "" {
					break
				}
				if round == 0 {
					between()
				}
				next := p.NextCursor
				p = page{}
				s.call(t, s.owner, "", "GET", w+"/tasks?"+query+"&cursor="+next, nil, 200, &p)
			}
			return got
		}
		got := read("project=SVA&open=1&limit=4", func() { s.change(t, s.owner, "", "task.update", M{"id": "SVA-2", "status": "done"}) })
		for i := 1; i <= 7; i++ {
			if key := fmt.Sprintf("SVA-%d", i); got[key] != 1 {
				t.Fatalf("after one closed between pages, %s came %d times: %v", key, got[key], got)
			}
		}
		// A task further down jumps to the top between pages: nothing repeats.
		got = read("project=SVA&sort=priority&limit=3", func() { s.change(t, s.owner, "", "task.update", M{"id": "SVA-6", "priority": "urgent"}) })
		for key, n := range got {
			if n != 1 {
				t.Fatalf("after a reorder between pages, %s came %d times: %v", key, n, got)
			}
		}
		// A cursor belongs to its list.
		var first page
		s.call(t, s.owner, "", "GET", w+"/tasks?sort=priority&limit=2", nil, 200, &first)
		s.call(t, s.owner, "", "GET", w+"/tasks?sort=-created&limit=2&cursor="+first.NextCursor, nil, 400, nil)
		if out := s.call(t, s.owner, "", "GET", w+"/tasks?limit=3&format=text", nil, 200, nil); !strings.Contains(out, "more: add cursor=") {
			t.Fatalf("the text form does not say how to go on: %s", out)
		}
		s.call(t, s.owner, "", "GET", w+"/tasks?cursor=nonsense", nil, 400, nil)
	})
}

// TestRestoreOneThingFromTheAdminArea checks that one task can be brought
// back from a backup without a shell.
func TestRestoreOneThingFromTheAdminArea(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		var made struct {
			Backup struct{ ID string }
			ID     string
		}
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &made)
		bid := made.Backup.ID
		if bid == "" {
			bid = made.ID
		}
		s.change(t, s.owner, "", "task.update", M{"id": "SVA-1", "title": "Changed since the backup"})
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups/"+bid+"/restore-item", M{"workspace": "games", "task": "SVA-1"}, 200, nil)
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil); !strings.Contains(out, "Boss design") {
			t.Fatalf("the task after restoring it from the backup: %s", out)
		}
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups/"+bid+"/restore-item", M{"workspace": "games", "task": "SVA-99"}, 404, nil)
		if out := s.call(t, s.owner, "", "GET", w+"/audit?action=task.restored_from_backup", nil, 200, nil); !strings.Contains(out, "SVA-1") {
			t.Fatalf("the restore is not on the record: %s", out)
		}
	})
}

// TestSecondAuditFindings pins what a second independent check found.
func TestSecondAuditFindings(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		for _, h := range []string{"asker", "judge", "narrow"} {
			s.change(t, s.owner, "", "agent.create", M{"name": h, "handle": h, "role": "admin"})
		}
		tok := func(h string) string {
			var out struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@" + h}, 201, &out)
			return out.Token
		}
		asker, judge := tok("asker"), tok("judge")
		do := func(token, typ string, args M, want int) string {
			return s.call(t, nil, token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": typ, "args": args}, want, nil)
		}
		// An approval for a change is asked of a person and given by one.
		hook := M{"name": "out", "url": "https://example.com/hook"}
		do(asker, "decision.open", M{"task": "SVA-1", "kind": "approval", "action": "webhook.create", "args": hook, "question": "Add the hook?", "ask": "@judge"}, 400)
		ask := s.change(t, nil, asker, "decision.open", M{"task": "SVA-1", "kind": "approval", "action": "webhook.create", "args": hook, "question": "Add the hook?"})["ref"].(string)
		do(judge, "decision.pick", M{"id": ask, "outcome": "approved"}, 403)
		s.change(t, s.owner, "", "decision.pick", M{"id": ask, "outcome": "approved"})

		// Narrowing an agent's projects keeps what it must ask for.
		s.change(t, s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"projects": []string{"OPS"}}})
		narrow := tok("narrow")
		if out := do(narrow, "webhook.create", hook, 403); !strings.Contains(out, "needs_approval") {
			t.Fatalf("a narrowed agent lost its approvals: %s", out)
		}
		// A file on another project's task is not for a member limited to one.
		var f struct{ ID, URL string }
		s.call(t, s.owner, "", "POST", w+"/files?name=secret.txt", []byte("for SVA eyes"), 201, &f)
		s.change(t, s.owner, "", "attachment.add", M{"task": "SVA-1", "file": f.ID})
		path := strings.TrimPrefix(f.URL, s.url)
		s.call(t, nil, narrow, "GET", path, nil, 404, nil)
		s.call(t, nil, asker, "GET", path, nil, 200, nil)
		if out := s.call(t, nil, narrow, "GET", "/api/v1/w/-/list/projects", nil, 200, nil); strings.Contains(out, "Samurai") {
			t.Fatalf("a limited agent is shown the other project: %s", out)
		}
		// Helpers: at most three at work on a task, and gone with a deleted task.
		for i := range 3 {
			do(asker, "agent.create", M{"name": fmt.Sprintf("Helper %d", i), "handle": fmt.Sprintf("helper%d", i), "task": "OPS-1"}, 200)
		}
		do(asker, "agent.create", M{"name": "One more", "handle": "helper9", "task": "OPS-1"}, 409)
		s.change(t, s.owner, "", "task.delete", M{"id": "OPS-1"})
		if out := s.call(t, s.owner, "", "GET", w+"/list/members", nil, 200, nil); strings.Count(out, `"suspended_at"`) < 3 {
			t.Fatalf("helpers of a deleted task are still at work: %s", out)
		}
		// Waiting on an outside event from a comment, and letting go of it.
		do(asker, "comment.create", M{"task": "SVA-1", "body": "Sent for review.", "waiting_on": "outside", "waiting_on_note": "the store's review"}, 200)
		if out := s.call(t, s.owner, "", "GET", w+"/tasks?waiting_on=outside&format=text", nil, 200, nil); !strings.Contains(out, "SVA-1") {
			t.Fatalf("waiting on the outside after a comment: %s", out)
		}
		s.change(t, s.owner, "", "task.update", M{"id": "SVA-1", "waiting_on": nil})
		if out := s.call(t, s.owner, "", "GET", w+"/tasks?waiting_on=outside&format=text", nil, 200, nil); strings.Contains(out, "SVA-1") {
			t.Fatalf("an outside wait could not be cleared: %s", out)
		}
		// Settings: a value of another shape is refused; null resets.
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/mail", M{"value": M{"host": "x", "password": "p-123456"}}, 400, nil)
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/mail", M{"host": "smtp.example.com", "from": "q@example.com", "password": "p-123456"}, 200, nil)
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/mail", json.RawMessage("null"), 200, nil)
		if out := s.call(t, s.owner, "", "GET", "/api/v1/admin/settings", nil, 200, nil); strings.Contains(out, "smtp.example.com") || strings.Contains(out, "p-123456") {
			t.Fatalf("a setting reset with null is still there: %s", out)
		}
		// A wrong kind of value is explained.
		if out := do(asker, "task.update", M{"id": "SVA-1", "estimate": true}, 400); !strings.Contains(out, "estimate takes a number") {
			t.Fatalf("a wrong kind of value: %s", out)
		}
		// The same change sent again says what it made.
		body := M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Made once"}}
		s.call(t, nil, asker, "POST", "/api/v1/w/-/changes", body, 200, nil)
		if out := s.call(t, nil, asker, "POST", "/api/v1/w/-/changes", body, 200, nil); !strings.Contains(out, `"duplicate":true`) || !strings.Contains(out, `"key":"SVA-`) {
			t.Fatalf("a repeated change does not say what it made: %s", out)
		}
		// Guessing tokens is slowed down. Counts start again each minute, and
		// the run may cross into the next one: twice the limit and more puts
		// one minute over it.
		limited := false
		tries := 2*120 + 10 // limitBadTokens is 120 a minute
		for i := 0; i < tries && !limited; i++ {
			req, _ := http.NewRequest(http.MethodGet, s.url+"/api/v1/w/-/me", nil)
			req.Header.Set("Authorization", "Bearer qd_not_a_token")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			limited = resp.StatusCode == http.StatusTooManyRequests
			resp.Body.Close()
		}
		if !limited {
			t.Fatalf("%d wrong tokens in a row were never slowed down", tries)
		}
	})
}

// TestTheVaultBlanksTheValueInEveryFormItSends: a service that says back
// what it was sent does not hand the secret to the agent, in whichever
// form the vault sent it: as written, in base64, inside Basic sign-in's
// base64 of user:value, escaped in an address, escaped in JSON. An answer
// the vault cannot read as text (bytes, or compressed) is not passed on at
// all, only what it is and how long, both blanked as the headers are, for
// a service can say the value back in them; one cut at the limit is blanked
// before it is cut; and the audit log has the address as the agent wrote
// it, not with the value in it.
func TestTheVaultBlanksTheValueInEveryFormItSends(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		const key = `pa/ss+w"rd?&=é 42`
		api := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			said := r.Method + " " + r.URL.RequestURI() + " " + r.Header.Get("Authorization") + " " + string(body)
			switch r.URL.Path {
			case "/bytes":
				// What an answer says of itself can say the value back too.
				rw.Header().Set("Content-Type", "application/octet-stream; echoed="+said)
				rw.Write([]byte("\x00\x01" + said))
			case "/encoded":
				rw.Header().Set("Content-Encoding", "x-"+url.QueryEscape(said))
				rw.Write([]byte(said))
			case "/gzip":
				rw.Header().Set("Content-Type", "application/json")
				rw.Header().Set("Content-Encoding", "gzip")
				zw := gzip.NewWriter(rw)
				zw.Write([]byte(`{"said":` + strconv.Quote(said) + `}`))
				zw.Close()
			case "/long":
				rw.Header().Set("Content-Type", "text/plain")
				rw.Write([]byte(strings.Repeat("a", 1<<20-5) + strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
			default:
				quoted, _ := json.Marshal(said)
				rw.Header().Set("Content-Type", "application/json")
				rw.Header().Set("X-Said", url.QueryEscape(said))
				rw.Write([]byte(`{"said":` + string(quoted) + `}`))
			}
		}))
		defer api.Close()
		s.change(t, s.owner, "", "secret.set", M{"name": "ODD_KEY", "value": key, "hosts": []string{"http://" + strings.TrimPrefix(api.URL, "http://")}})
		forms := map[string]string{
			"as written": key, "base64": base64.StdEncoding.EncodeToString([]byte(key)), "basic": base64.StdEncoding.EncodeToString([]byte("bot:" + key)),
			"query-escaped": url.QueryEscape(key), "path-escaped": url.PathEscape(key), "JSON-escaped": strings.Trim(string(must(json.Marshal(key))), `"`),
		}
		leaks := func(t *testing.T, out string) {
			t.Helper()
			for form, v := range forms {
				if strings.Contains(out, v) {
					t.Fatalf("the value came back %s: %s", form, out)
				}
			}
		}
		ask := func(t *testing.T, path string, headers M, body string) string {
			t.Helper()
			return s.call(t, s.owner, "", "POST", w+"/secrets/ODD_KEY/request", M{"method": "POST", "url": api.URL + path, "headers": headers, "body": body}, 200, nil)
		}

		t.Run("echoed", func(t *testing.T) {
			for _, headers := range []M{{"Authorization": "Bearer {{secret}}"}, {"Authorization": "Basic {{basic:bot}}"}, {"Authorization": "Token {{secret:base64}}"}} {
				out := ask(t, "/echo?k={{secret}}", headers, `{"k":"{{secret}}"}`)
				leaks(t, out)
				if !strings.Contains(out, "•••") {
					t.Fatalf("nothing was blanked: %s", out)
				}
			}
			leaks(t, ask(t, "/echo/{{secret}}", nil, ""))
		})
		t.Run("not text", func(t *testing.T) {
			// Compressed, asked for by the agent: the vault asks for it
			// itself and undoes it, so the answer is read as text.
			leaks(t, ask(t, "/gzip", M{"Authorization": "Bearer {{secret}}", "Accept-Encoding": "gzip"}, ""))
			for _, path := range []string{"/bytes", "/encoded"} {
				var res struct {
					OK         bool
					Body       *string
					BodyBase64 *string `json:"body_base64"`
					Omitted    string  `json:"body_omitted"`
					Size       int
				}
				out := ask(t, path, M{"Authorization": "Bearer {{secret}}", "Accept-Encoding": "gzip"}, "")
				leaks(t, out)
				if err := json.Unmarshal([]byte(out), &res); err != nil {
					t.Fatal(err)
				}
				if !res.OK || res.Body != nil || res.BodyBase64 != nil || res.Omitted == "" || res.Size == 0 {
					t.Fatalf("%s: %s", path, out)
				}
				leaks(t, s.call(t, s.owner, "", "POST", w+"/secrets/ODD_KEY/request?format=text",
					M{"method": "POST", "url": api.URL + path, "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, nil))
			}
		})
		t.Run("cut at the limit", func(t *testing.T) {
			out := ask(t, "/long", M{"Authorization": "Bearer {{secret}}"}, "")
			var res struct {
				Body      string
				Truncated bool
			}
			if err := json.Unmarshal([]byte(out), &res); err != nil {
				t.Fatal(err)
			}
			if !res.Truncated || strings.HasSuffix(res.Body, key[:5]) || strings.Contains(res.Body, key[:5]) {
				t.Fatalf("a cut answer ends with the start of the value: …%q", res.Body[len(res.Body)-20:])
			}
		})
		t.Run("on the record", func(t *testing.T) {
			if out := s.call(t, s.owner, "", "GET", w+"/audit?action=secret.used", nil, 200, nil); !strings.Contains(out, "/echo/{{secret}}") {
				leaks(t, out)
				t.Fatalf("the audit log does not have the address as written: %s", out)
			}
		})
	})
}

// must is v, for a call that cannot fail here.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// TestARequestThatChangesSomethingIsHeldAsAChangeIs: a request sent with a
// secret that can change something at the far end (a POST, a DELETE) is
// held as a change is: not by a member who may only read, and only with an
// approval from an agent that must ask before it. A GET only looks.
func TestARequestThatChangesSomethingIsHeldAsAChangeIs(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Deploy"})
		var calls []string
		api := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			calls = append(calls, r.Method+" "+r.URL.Path)
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`{"ok":true}`))
		}))
		defer api.Close()
		host := "http://" + strings.TrimPrefix(api.URL, "http://")
		s.change(t, s.owner, "", "secret.set", M{"name": "DEPLOY_KEY", "value": "sk-held-1234", "hosts": []string{host}})
		agent := func(handle string, scope M) string {
			s.change(t, s.owner, "", "agent.create", M{"name": handle, "handle": handle, "scope": scope})
			var out struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@" + handle}, 201, &out)
			return out.Token
		}
		deploy := `{"ref":"main"}`
		sendAs := func(token string, request M, approval string, want int) string {
			t.Helper()
			body := M{"url": api.URL + "/deploy", "headers": M{"Authorization": "Bearer {{secret}}"}, "body": deploy}
			maps.Copy(body, request)
			if approval != "" {
				body["approval"] = approval
			}
			return s.call(t, nil, token, "POST", "/api/v1/w/-/secrets/DEPLOY_KEY/request", body, want, nil)
		}
		send := func(token, method string, approval string, want int) string {
			t.Helper()
			return sendAs(token, M{"method": method}, approval, want)
		}

		t.Run("not by a member who may only read", func(t *testing.T) {
			reader := agent("reader", M{"read_only": true, "needs_approval": []string{}})
			send(reader, "POST", "", 403)
			send(reader, "GET", "", 403)
		})
		t.Run("with an approval when the agent must ask", func(t *testing.T) {
			asker := agent("asker", nil) // a new agent asks before what reaches outside
			before := len(calls)
			send(asker, "GET", "", 200)
			if out := send(asker, "POST", "", 403); !strings.Contains(out, "needs_approval") || !strings.Contains(out, `to ask with: {\"body\"`) {
				t.Fatalf("a POST with a secret went without the approval it needs, or the refusal does not say what to ask for: %s", out)
			}
			if len(calls) != before+1 {
				t.Fatalf("calls made: %v", calls[before:])
			}
			request := M{"name": "DEPLOY_KEY", "method": "POST", "url": api.URL + "/deploy", "headers": M{"Authorization": "Bearer {{secret}}"}, "body": deploy}
			ask := s.change(t, nil, asker, "decision.open", M{"task": "SVA-1", "kind": "approval", "action": "secret.send", "args": request, "question": "Deploy?"})["ref"].(string)
			s.change(t, s.owner, "", "decision.pick", M{"id": ask, "outcome": "approved"})
			// The approval is of the whole request as written: any other
			// method, header or body is another request, which needs its own.
			send(asker, "DELETE", ask, 403)
			sendAs(asker, M{"method": "POST", "body": `{"ref":"evil"}`}, ask, 403)
			sendAs(asker, M{"method": "POST", "body": "", "body_base64": base64.StdEncoding.EncodeToString([]byte(`{"ref":"evil"}`))}, ask, 403)
			sendAs(asker, M{"method": "POST", "headers": M{"Authorization": "Bearer {{secret}}", "X-HTTP-Method-Override": "DELETE"}}, ask, 403)
			send(asker, "POST", ask, 200)
			send(asker, "POST", ask, 403)
			if got := calls[len(calls)-1]; got != "POST /deploy" || len(calls) != before+2 {
				t.Fatalf("calls made: %v", calls[before:])
			}
		})
	})
}
