package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestMCPWithOAuth(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion effect"})

		// With no token the server says where to sign in.
		resp, _ := http.Post(s.url+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(resp.Header.Get("WWW-Authenticate"), "/.well-known/oauth-protected-resource") {
			t.Fatalf("unauthenticated MCP: %d %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
		}
		var meta struct {
			Auth  string `json:"authorization_endpoint"`
			Token string `json:"token_endpoint"`
			Reg   string `json:"registration_endpoint"`
		}
		s.call(t, nil, "", "GET", "/.well-known/oauth-authorization-server", nil, 200, &meta)

		// The client registers, the person approves, the client gets a token.
		var cl struct {
			ID string `json:"client_id"`
		}
		redirect := "http://localhost:9999/callback"
		s.call(t, nil, "", "POST", "/oauth/register", M{"client_name": "Test Client", "redirect_uris": []string{redirect}}, 201, &cl)
		s.call(t, nil, "", "POST", "/oauth/register", M{"client_name": "Evil", "redirect_uris": []string{"http://evil.example.com/cb"}}, 400, nil)
		verifier := "a-long-random-verifier-string-for-pkce-0123456789"
		sum := sha256.Sum256([]byte(verifier))
		authURL := meta.Auth + "?" + url.Values{"response_type": {"code"}, "client_id": {cl.ID}, "redirect_uri": {redirect}, "state": {"xyz"},
			"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}}.Encode()
		page, err := s.owner.Get(authURL)
		if err != nil {
			t.Fatal(err)
		}
		html, _ := io.ReadAll(page.Body)
		page.Body.Close()
		if !strings.Contains(string(html), "Let Test Client in?") {
			t.Fatalf("consent page: %.300s", html)
		}
		field := func(name string) string {
			i := strings.Index(string(html), `name="`+name+`" value="`)
			rest := string(html)[i+len(name)+15:]
			return rest[:strings.Index(rest, `"`)]
		}
		wsID := string(html)[strings.Index(string(html), `<option value="`)+15:]
		wsID = wsID[:strings.Index(wsID, `:`)] // the option is workspace:member; alone, the workspace means "as myself"
		noFollow := *s.owner
		noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		done, err := noFollow.PostForm(s.url+"/oauth/authorize", url.Values{"request": {field("request")}, "workspace": {wsID}, "answer": {"allow"}})
		if err != nil {
			t.Fatal(err)
		}
		done.Body.Close()
		loc, _ := url.Parse(done.Header.Get("Location"))
		if loc.Query().Get("state") != "xyz" || loc.Query().Get("code") == "" || !strings.HasPrefix(loc.String(), redirect) {
			t.Fatalf("redirect back = %s", loc)
		}
		form := url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")}, "client_id": {cl.ID}, "redirect_uri": {redirect}, "code_verifier": {"wrong"}}
		bad, _ := http.PostForm(meta.Token, form)
		bad.Body.Close()
		if bad.StatusCode != http.StatusBadRequest {
			t.Fatalf("a wrong verifier got %d", bad.StatusCode)
		}
		// The failed try used the code up, so go round again for a fresh one.
		page, _ = s.owner.Get(authURL)
		html, _ = io.ReadAll(page.Body)
		page.Body.Close()
		done, _ = noFollow.PostForm(s.url+"/oauth/authorize", url.Values{"request": {field("request")}, "workspace": {wsID}, "answer": {"allow"}})
		done.Body.Close()
		loc, _ = url.Parse(done.Header.Get("Location"))
		form.Set("code", loc.Query().Get("code"))
		form.Set("code_verifier", verifier)
		var tok struct {
			Access  string `json:"access_token"`
			Refresh string `json:"refresh_token"`
		}
		tr, _ := http.PostForm(meta.Token, form)
		json.NewDecoder(tr.Body).Decode(&tok)
		tr.Body.Close()
		if tok.Access == "" || tok.Refresh == "" {
			t.Fatal("no token issued")
		}

		rpc := func(token, method string, params any) map[string]any {
			t.Helper()
			body, _ := json.Marshal(M{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
			req, _ := http.NewRequest(http.MethodPost, s.url+"/mcp", strings.NewReader(string(body)))
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var out struct {
				Result map[string]any `json:"result"`
				Error  any            `json:"error"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Error != nil {
				t.Fatalf("%s: %v %v (status %d)", method, err, out.Error, resp.StatusCode)
			}
			return out.Result
		}
		text := func(res map[string]any) string {
			return res["content"].([]any)[0].(map[string]any)["text"].(string)
		}
		if v := rpc(tok.Access, "initialize", M{"protocolVersion": "2025-03-26"})["protocolVersion"]; v != "2025-03-26" {
			t.Fatalf("protocol version = %v", v)
		}
		tools := rpc(tok.Access, "tools/list", nil)["tools"].([]any)
		if len(tools) < 15 || len(tools) > 26 {
			t.Fatalf("the tool list should stay short: %d tools", len(tools))
		}
		// The token works as the person who approved it.
		if out := text(rpc(tok.Access, "tools/call", M{"name": "whoami"})); !strings.Contains(out, "you are @aram (person, owner)") {
			t.Fatalf("whoami = %s", out)
		}
		if out := text(rpc(tok.Access, "tools/call", M{"name": "tasks", "arguments": M{"project": "SVA", "open": true}})); !strings.Contains(out, "SVA-1  [Todo]  Explosion effect") {
			t.Fatalf("tasks = %s", out)
		}
		made := rpc(tok.Access, "tools/call", M{"name": "change", "arguments": M{"type": "comment.create", "args": M{"task": "SVA-1", "body": "from MCP"}}})
		if made["isError"] == true || !strings.HasPrefix(text(made), "ok comment.create SVA-1") {
			t.Fatalf("change = %v", made)
		}
		// A refusal comes back as a tool error that says how to fix the call.
		bad2 := rpc(tok.Access, "tools/call", M{"name": "change", "arguments": M{"type": "task.update", "args": M{"id": "SVA-1", "status": "Dne"}}})
		if bad2["isError"] != true || !strings.Contains(text(bad2), "did you mean Done?") {
			t.Fatalf("refusal = %v", bad2)
		}
		up := text(rpc(tok.Access, "tools/call", M{"name": "upload", "arguments": M{"name": "notes.txt", "text": "hello"}}))
		if !strings.HasPrefix(up, "file id=") {
			t.Fatalf("upload = %s", up)
		}
		if out := text(rpc(tok.Access, "tools/call", M{"name": "task", "arguments": M{"key": "SVA-1"}})); !strings.Contains(out, "from MCP") {
			t.Fatalf("task = %s", out)
		}
		// Several changes at once, all or nothing; and a change sent twice with
		// one id is made once.
		batch := text(rpc(tok.Access, "tools/call", M{"name": "change", "arguments": M{"changes": []M{
			{"type": "task.create", "args": M{"project": "SVA", "title": "From a batch, one"}},
			{"type": "task.create", "args": M{"project": "SVA", "title": "From a batch, two"}}}}}))
		if strings.Count(batch, "ok task.create") != 2 {
			t.Fatalf("batch = %s", batch)
		}
		once := M{"name": "change", "arguments": M{"id": "0192f0c0-0000-7000-8000-0000000000aa", "type": "comment.create", "args": M{"task": "SVA-1", "body": "said once"}}}
		rpc(tok.Access, "tools/call", once)
		rpc(tok.Access, "tools/call", once)
		if out := text(rpc(tok.Access, "tools/call", M{"name": "task", "arguments": M{"key": "SVA-1", "full": true}})); strings.Count(out, "said once") != 1 {
			t.Fatalf("a change retried with its id was made twice: %s", out)
		}
		// A file in parts.
		part := func(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
		big := []byte(strings.Repeat("0123456789", 500))
		first := text(rpc(tok.Access, "tools/call", M{"name": "upload", "arguments": M{"name": "big.bin", "size": len(big), "base64": part(big[:2000])}}))
		fid := strings.TrimPrefix(strings.Fields(first)[1], "id=")
		if !strings.Contains(first, "received 2000 of 5000") {
			t.Fatalf("first part = %s", first)
		}
		if last := text(rpc(tok.Access, "tools/call", M{"name": "upload", "arguments": M{"id": fid, "offset": 2000, "base64": part(big[2000:])}})); !strings.Contains(last, "ready") {
			t.Fatalf("last part = %s", last)
		}
		if out := text(rpc(tok.Access, "tools/call", M{"name": "file", "arguments": M{"id": fid}})); !strings.Contains(out, "5000") {
			t.Fatalf("file = %s", out)
		}
		if out := text(rpc(tok.Access, "tools/call", M{"name": "dashboard"})); out == "" || strings.Contains(out, "not found") {
			t.Fatalf("dashboard = %s", out)
		}

		// The same client let in as an agent works under the agent's name.
		s.change(t, s.owner, "", "agent.create", M{"name": "Coder", "handle": "coder"})
		var list struct {
			Members []struct {
				Handle string
				UserID string `json:"user_id"`
			}
		}
		s.call(t, s.owner, "", "GET", w+"/list/members", nil, 200, &list)
		agentID := ""
		for _, m := range list.Members {
			if m.Handle == "coder" {
				agentID = m.UserID
			}
		}
		asAgent := func(as string) string {
			ch := sha256.Sum256([]byte("verifier-two"))
			page, _ := s.owner.Get(meta.Auth + "?" + url.Values{"client_id": {cl.ID}, "redirect_uri": {redirect}, "response_type": {"code"},
				"code_challenge": {base64.RawURLEncoding.EncodeToString(ch[:])}, "code_challenge_method": {"S256"}}.Encode())
			raw, _ := io.ReadAll(page.Body)
			page.Body.Close()
			if !strings.Contains(string(raw), "Coder (agent, @coder)") {
				t.Fatalf("the consent page does not offer the agent: %s", raw)
			}
			m := regexp.MustCompile(`name="request" value="([^"]+)"`).FindStringSubmatch(string(raw))
			done, err := noFollow.PostForm(s.url+"/oauth/authorize", url.Values{"request": {m[1]}, "as": {as}, "answer": {"allow"}})
			if err != nil {
				t.Fatal(err)
			}
			done.Body.Close()
			if done.StatusCode != http.StatusFound {
				return ""
			}
			loc, _ := url.Parse(done.Header.Get("Location"))
			tr, _ := http.PostForm(meta.Token, url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")}, "client_id": {cl.ID},
				"redirect_uri": {redirect}, "code_verifier": {"verifier-two"}})
			var got struct {
				Access string `json:"access_token"`
			}
			json.NewDecoder(tr.Body).Decode(&got)
			tr.Body.Close()
			return got.Access
		}
		agentTok := asAgent(wsID + ":" + agentID)
		if out := text(rpc(agentTok, "tools/call", M{"name": "whoami"})); !strings.Contains(out, "you are @coder (agent") {
			t.Fatalf("a client let in as an agent is: %s", out)
		}
		if asAgent(wsID+":"+"0192f0c0-0000-7000-8000-00000000dead") != "" {
			t.Fatal("a client was let in as someone the person cannot offer")
		}

		// Refreshing gives a new pair and ends the old one.
		rr, _ := http.PostForm(meta.Token, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok.Refresh}, "client_id": {cl.ID}})
		var next struct {
			Access string `json:"access_token"`
		}
		json.NewDecoder(rr.Body).Decode(&next)
		rr.Body.Close()
		if next.Access == "" || next.Access == tok.Access {
			t.Fatal("refresh gave no new token")
		}
		resp, _ = http.DefaultClient.Do(func() *http.Request {
			req, _ := http.NewRequest(http.MethodPost, s.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
			req.Header.Set("Authorization", "Bearer "+tok.Access)
			return req
		}())
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("the old token still works after a refresh: %d", resp.StatusCode)
		}
		rpc(next.Access, "ping", nil)
	})
}

// feedReads is a store that, once armed, keeps the context of the first
// read of the feed made for a request. The server's background work reads
// the feed too, under a context no client ends.
type feedReads struct {
	store.Store
	armed atomic.Bool
	mu    sync.Mutex
	first context.Context
}

func (s *feedReads) In(workspaceID string) store.DB {
	return feedReadsDB{DB: s.Store.In(workspaceID), reads: s}
}

// read is the context of the first read for a request since the store was
// armed, nil before it.
func (s *feedReads) read() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.first
}

type feedReadsDB struct {
	store.DB
	reads *feedReads
}

func (d feedReadsDB) Events(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	if d.reads.armed.Load() && ctx.Value(http.ServerContextKey) != nil {
		d.reads.mu.Lock()
		if d.reads.first == nil {
			d.reads.first = ctx
		}
		d.reads.mu.Unlock()
	}
	return d.DB.Events(ctx, f)
}

func TestAToolCallEndsWhenItsClientGoesAway(t *testing.T) {
	t.Parallel()
	reads := &feedReads{Store: testdb.SQLite(t)}
	s := newSite(t, reads)
	token := s.agentToken(t, "artist")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reads.armed.Store(true)
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url+"/mcp",
			strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"events","arguments":{"wait":50}}}`))
		if err != nil {
			t.Error(err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	eventually(t, "the tool to read the feed", func() bool { return reads.read() != nil })
	cancel()
	<-gone
	eventually(t, "the tool's work to end with its client", func() bool { return reads.read().Err() != nil })
}
