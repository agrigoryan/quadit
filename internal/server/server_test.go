package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// site is a running server with a signed-in owner.
type site struct {
	url   string
	dir   string
	owner *http.Client
	srv   *server.Server
	// stopRun ends the server's background work and returns when Run has.
	stopRun func()
}

// newSite starts a server that may reach this machine: the servers tests
// stand up for it to call (webhooks, the vault's services, an Orbit to
// import from) listen on the loopback.
func newSite(t *testing.T, st store.Store) *site {
	t.Helper()
	return newSiteWith(t, st, func(cfg *server.Config) { cfg.PrivateNetworks = loopback })
}

// loopback is this machine's addresses, in IPv4 and IPv6.
var loopback = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}

// newSiteWithFiles is newSite keeping its files in files.
func newSiteWithFiles(t *testing.T, st store.Store, files blob.Store) *site {
	t.Helper()
	return newSiteOf(t, st, files, func(cfg *server.Config) { cfg.PrivateNetworks = loopback })
}

// newSiteWith starts a server with what configure sets on its Config.
func newSiteWith(t *testing.T, st store.Store, configure func(*server.Config)) *site {
	t.Helper()
	return newSiteOf(t, st, nil, configure)
}

// newSiteOf starts a server keeping its files in files, or on disk in the
// site's folder when that is nil, with what configure sets on its Config.
func newSiteOf(t *testing.T, st store.Store, files blob.Store, configure func(*server.Config)) *site {
	t.Helper()
	dir := t.TempDir()
	if files == nil {
		disk, err := blob.NewDisk(dir + "/files")
		if err != nil {
			t.Fatal(err)
		}
		files = disk
	}
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	hs, base := localhostServer(t)
	cfg := server.Config{DataDir: dir, BaseURL: base, Version: "test"}
	if configure != nil {
		configure(&cfg)
	}
	ctx, stop := context.WithCancel(context.Background())
	srv := server.New(ctx, cfg, st, files, sealer)
	hs.Config.Handler = srv.Handler()
	hs.Start()
	ran := make(chan struct{})
	go func() {
		defer close(ran)
		srv.Run(ctx)
	}()
	stopRun := func() { stop(); <-ran }
	t.Cleanup(func() { stopRun(); hs.Close() })
	s := &site{url: base, dir: dir, owner: browser(), srv: srv, stopRun: stopRun}
	s.call(t, s.owner, "", "POST", "/api/v1/auth/setup", map[string]any{"name": "Aram", "email": "owner@example.com",
		"password": "correct-horse-battery", "workspace_name": "Games"}, 201, nil)
	return s
}

// call sends a request and decodes the answer, checking the status.
func (s *site) call(t *testing.T, hc *http.Client, token, method, path string, body any, want int, out any) string {
	t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, s.url+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: %v: %s", method, path, err, raw)
		}
	}
	return string(raw)
}

const w = "/api/v1/w/games"

func (s *site) change(t *testing.T, hc *http.Client, token, typ string, args any) map[string]any {
	t.Helper()
	var out struct {
		Results []map[string]any `json:"results"`
	}
	s.call(t, hc, token, "POST", w+"/changes", map[string]any{"id": id.New(), "type": typ, "args": args}, 200, &out)
	return out.Results[0]
}

type M = map[string]any

func TestAPI(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var tok struct {
			Token string `json:"token"`
		}
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist", "projects": []string{"SVA"}}, 201, &tok)
		agent := tok.Token

		// No credentials, no entry; a bad token says so.
		s.call(t, nil, "", "GET", w+"/me", nil, 401, nil)
		s.call(t, nil, "qd_nope", "GET", w+"/me", nil, 401, nil)

		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion effect", "assignee": "@artist"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})

		// The token's workspace is "-"; the agent sees only its project.
		var tasks struct {
			Tasks []M `json:"tasks"`
		}
		s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks", nil, 200, &tasks)
		if len(tasks.Tasks) != 1 || tasks.Tasks[0]["key"] != "SVA-1" || tasks.Tasks[0]["assignee"] != "@artist" {
			t.Fatalf("agent tasks = %+v", tasks.Tasks)
		}
		s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/OPS-1", nil, 404, nil)
		s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks?project=OPS", nil, 403, nil)
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks?asignee=me", nil, 400, nil); !strings.Contains(out, `"nearest":"assignee"`) {
			t.Fatalf("misspelled parameter should be corrected: %s", out)
		}
		// The compact text form.
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/my-work?format=text", nil, 200, nil); !strings.Contains(out, "SVA-1  [Todo]  @artist  Explosion effect") {
			t.Fatalf("my-work text = %s", out)
		}

		// A held request returns as soon as something happens.
		var me struct {
			Seq int64 `json:"seq"`
		}
		s.call(t, nil, agent, "GET", "/api/v1/w/-/me", nil, 200, &me)
		got := make(chan string, 1)
		start := time.Now()
		go func() {
			got <- s.call(t, nil, agent, "GET", fmt.Sprintf("/api/v1/w/-/events?after=%d&wait=20&format=text&others=1", me.Seq), nil, 200, nil)
		}()
		time.Sleep(150 * time.Millisecond)
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "@artist no rings please"})
		select {
		case out := <-got:
			if !strings.Contains(out, "no rings please") || time.Since(start) > 5*time.Second {
				t.Fatalf("held request: %q after %s", out, time.Since(start))
			}
		case <-time.After(8 * time.Second):
			t.Fatal("the held request did not wake")
		}

		// A cursor kept by the server: read, acknowledge, read again.
		var page struct {
			Events []json.RawMessage `json:"events"`
			Seq    int64             `json:"seq"`
		}
		s.call(t, nil, agent, "GET", "/api/v1/w/-/events?cursor=main", nil, 200, &page)
		if len(page.Events) == 0 {
			t.Fatal("cursor read returned nothing")
		}
		s.call(t, nil, agent, "GET", fmt.Sprintf("/api/v1/w/-/events?cursor=main&ack=%d", page.Seq), nil, 200, &page)
		if len(page.Events) != 0 {
			t.Fatalf("after ack the cursor still returns %d events", len(page.Events))
		}

		// Upload in two parts, then read a range back.
		data := bytes.Repeat([]byte("quadit "), 1000)
		var f struct {
			ID, State, URL string
			Received       int64
		}
		s.call(t, nil, agent, "POST", fmt.Sprintf("/api/v1/w/-/files?name=notes.txt&size=%d", len(data)), data[:3000], 201, &f)
		if f.State != "uploading" || f.Received != 3000 {
			t.Fatalf("first part = %+v", f)
		}
		s.call(t, nil, agent, "PATCH", "/api/v1/w/-/files/"+f.ID+"?offset=1", data[3000:], 409, nil)
		s.call(t, nil, agent, "PATCH", "/api/v1/w/-/files/"+f.ID+"?offset=3000", data[3000:], 200, &f)
		if f.State != "ready" {
			t.Fatalf("upload did not finish: %+v", f)
		}
		req, _ := http.NewRequest(http.MethodGet, s.url+"/f/"+f.ID+"/notes.txt", nil)
		req.Header.Set("Authorization", "Bearer "+agent)
		req.Header.Set("Range", "bytes=7-12")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		part, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusPartialContent || string(part) != "quadit" {
			t.Fatalf("range read = %d %q", resp.StatusCode, part)
		}
		s.change(t, nil, agent, "attachment.add", M{"task": "SVA-1", "file": f.ID})

		// The context pack and the web app's starting copy.
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1/context?format=text", nil, 200, nil); !strings.Contains(out, "notes.txt") {
			t.Fatalf("context pack misses the attachment: %s", out)
		}
		var boot map[string]json.RawMessage
		s.call(t, s.owner, "", "GET", w+"/bootstrap", nil, 200, &boot)
		for _, k := range []string{"tasks", "members", "statuses", "claims", "sessions"} {
			if string(boot[k]) == "null" || len(boot[k]) == 0 {
				t.Errorf("bootstrap %s = %s", k, boot[k])
			}
		}

		// A read-only token cannot write; a revoked one stops at once.
		var ro struct {
			Token string
			Info  struct{ ID string }
		}
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist", "read_only": true}, 201, &ro)
		s.call(t, nil, ro.Token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "x"}}, 403, nil)
		s.call(t, s.owner, "", "DELETE", w+"/tokens/"+ro.Info.ID, nil, 200, nil)
		s.call(t, nil, ro.Token, "GET", "/api/v1/w/-/me", nil, 401, nil)

		// Signing in: wrong password, then right.
		hc := browser()
		s.call(t, hc, "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": "wrong"}, 401, nil)
		s.call(t, hc, "", "POST", "/api/v1/auth/login", M{"email": "Owner@Example.com", "password": "correct-horse-battery"}, 200, nil)
		s.call(t, hc, "", "GET", "/api/v1/auth/me", nil, 200, nil)
		s.call(t, hc, "", "POST", "/api/v1/auth/logout", nil, 200, nil)
		s.call(t, hc, "", "GET", "/api/v1/auth/me", nil, 401, nil)
		// Setup works once.
		s.call(t, nil, "", "POST", "/api/v1/auth/setup", M{"name": "X", "email": "x@example.com", "password": "another-long-password", "workspace_name": "X"}, 409, nil)
	})
}

// TestLooseEnds covers small things that were missing: a deleted decision
// comes back, both ends of a relation hear of it, a webhook test is in the
// delivery log, the audit log pages without skipping, and the one who runs
// the install can step into a workspace they are not in.
func TestLooseEnds(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss music"})

		// A decision goes to the trash and comes back whole.
		d := s.change(t, s.owner, "", "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "options": []M{{"label": "Ring"}, {"label": "Burst"}}})["ref"].(string)
		s.change(t, s.owner, "", "decision.delete", M{"id": d})
		if out := s.call(t, s.owner, "", "GET", w+"/decisions?trash=1", nil, 200, nil); !strings.Contains(out, "Which explosion?") {
			t.Fatalf("decision trash: %s", out)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, nil); strings.Contains(out, "Which explosion?") {
			t.Fatal("a deleted decision is still on its task")
		}
		s.change(t, s.owner, "", "decision.restore", M{"id": d})
		if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, nil); !strings.Contains(out, "Which explosion?") || !strings.Contains(out, "Burst") {
			t.Fatalf("the decision did not come back with its options: %s", out)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/events?types=decision.restored", nil, 200, nil); !strings.Contains(out, `"label":"Burst"`) {
			t.Fatalf("the restore event does not carry the decision: %s", out)
		}
		if out := s.call(t, s.owner, "", "GET", w+"/search?q=explosion", nil, 200, nil); !strings.Contains(out, "Which explosion?") {
			t.Fatalf("a restored decision is not found by search: %s", out)
		}

		// A relation is heard on both tasks.
		rel := s.change(t, s.owner, "", "relation.add", M{"task": "SVA-1", "other": "SVA-2", "type": "blocks"})
		for _, key := range []string{"SVA-1", "SVA-2"} {
			if out := s.call(t, s.owner, "", "GET", w+"/events?task="+key+"&types=relation.created,task.related", nil, 200, nil); !strings.Contains(out, `"SVA-`) {
				t.Fatalf("%s did not hear of the relation: %s", key, out)
			}
		}
		_ = rel

		// A webhook test is in the delivery log.
		got := 0
		rcv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { got++; rw.WriteHeader(http.StatusNoContent) }))
		defer rcv.Close()
		hook := s.change(t, s.owner, "", "webhook.create", M{"name": "probe", "url": rcv.URL, "event_types": []string{"comment.created"}})["ref"].(string)
		s.call(t, s.owner, "", "POST", w+"/webhooks/"+hook+"/test", nil, 200, nil)
		var log struct {
			Deliveries []struct {
				ID, State  string
				EventType  string `json:"event_type"`
				StatusCode int    `json:"status_code"`
			}
		}
		s.call(t, s.owner, "", "GET", w+"/list/deliveries", nil, 200, &log)
		if got != 1 || len(log.Deliveries) != 1 || log.Deliveries[0].EventType != "webhook.test" || log.Deliveries[0].State != "ok" || log.Deliveries[0].StatusCode != http.StatusNoContent {
			t.Fatalf("test delivery log: got=%d %+v", got, log.Deliveries)
		}
		s.call(t, s.owner, "", "POST", w+"/deliveries/"+log.Deliveries[0].ID+"/redeliver", nil, 400, nil)

		// The audit log pages by entry, never skipping or repeating one.
		for i := range 7 {
			s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", i%2 == 0, 200, nil)
		}
		seen, cursor := map[string]bool{}, ""
		for range 20 {
			var out struct {
				Audit []struct{ ID string }
				Next  string
			}
			s.call(t, s.owner, "", "GET", "/api/v1/admin/audit?limit=3&cursor="+cursor, nil, 200, &out)
			for _, e := range out.Audit {
				if seen[e.ID] {
					t.Fatalf("audit entry %s came twice", e.ID)
				}
				seen[e.ID] = true
			}
			if cursor = out.Next; cursor == "" {
				break
			}
		}
		var all struct{ Audit []struct{ ID string } }
		s.call(t, s.owner, "", "GET", "/api/v1/admin/audit?limit=5000", nil, 200, &all)
		if len(seen) != len(all.Audit) || len(seen) < 8 {
			t.Fatalf("paged through %d audit entries of %d", len(seen), len(all.Audit))
		}

		// Someone else makes a workspace; the install admin is not in it, and
		// steps in as an admin, on the record.
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		dee := browser()
		s.call(t, dee, "", "POST", "/api/v1/auth/register", M{"name": "Dee", "email": "dee@example.com", "password": "another-long-password"}, 201, nil)
		var made struct{ ID, Slug string }
		s.call(t, dee, "", "POST", "/api/v1/workspaces", M{"name": "Dee's place", "slug": "dees"}, 201, &made)
		s.call(t, s.owner, "", "GET", "/api/v1/w/dees/me", nil, 404, nil)
		s.call(t, dee, "", "POST", "/api/v1/admin/workspaces/"+made.ID+"/join", nil, 403, nil)
		s.call(t, s.owner, "", "POST", "/api/v1/admin/workspaces/"+made.ID+"/join", nil, 200, nil)
		var me struct{ Role string }
		s.call(t, s.owner, "", "GET", "/api/v1/w/dees/me", nil, 200, &me)
		if me.Role != "admin" {
			t.Fatalf("joined as %q", me.Role)
		}
		if out := s.call(t, dee, "", "GET", "/api/v1/w/dees/audit", nil, 200, nil); !strings.Contains(out, "workspace.joined_by_install_admin") {
			t.Fatalf("the join is not in the workspace's audit log: %s", out)
		}
		if out := s.call(t, s.owner, "", "POST", "/api/v1/admin/workspaces/dees/join", nil, 200, nil); !strings.Contains(out, "already_member") {
			t.Fatalf("joining twice: %s", out)
		}
	})
}

// TestAnAdminWhoMayOnlyReadStartsNothing: what an admin starts outside the
// engine (an import, a sync, a webhook sent again or tried, withdrawing an
// invitation) is refused to a credential or a membership that may only
// read, as every change is.
func TestAnAdminWhoMayOnlyReadStartsNothing(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		var ro struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "me", "read_only": true}, 201, &ro)
		s.change(t, s.owner, "", "agent.create", M{"name": "Reader", "handle": "reader", "role": "admin", "scope": M{"read_only": true, "needs_approval": []string{}}})
		var reader struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@reader"}, 201, &reader)
		some := id.New()
		for _, path := range []string{"/import", "/integrations/" + some + "/sync", "/sources/" + some + "/sync", "/deliveries/" + some + "/redeliver", "/webhooks/" + some + "/test"} {
			for _, token := range []string{ro.Token, reader.Token} {
				if out := s.call(t, nil, token, "POST", "/api/v1/w/-"+path, M{}, 403, nil); !strings.Contains(out, "read-only") {
					t.Fatalf("POST %s: %s", path, out)
				}
			}
		}
		s.call(t, nil, ro.Token, "DELETE", "/api/v1/w/-/invites/"+some, nil, 403, nil)
	})
}
