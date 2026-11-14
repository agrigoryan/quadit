package server_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestMCPWithOAuth(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion effect"})

	// With no token the server says where to sign in.
	resp, _ := http.Post(s.url+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	resp.Body.Close()
	if resp.StatusCode != 401 || !strings.Contains(resp.Header.Get("WWW-Authenticate"), "/.well-known/oauth-protected-resource") {
		t.Fatalf("unauthenticated MCP: %d %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
	}
	var meta struct {
		Auth  string `json:"authorization_endpoint"`
		Token string `json:"token_endpoint"`
		Reg   string `json:"registration_endpoint"`
	}
	s.call(nil, "", "GET", "/.well-known/oauth-authorization-server", nil, 200, &meta)

	// The client registers, the person approves, the client gets a token.
	var cl struct {
		ID string `json:"client_id"`
	}
	redirect := "http://localhost:9999/callback"
	s.call(nil, "", "POST", "/oauth/register", M{"client_name": "Test Client", "redirect_uris": []string{redirect}}, 201, &cl)
	s.call(nil, "", "POST", "/oauth/register", M{"client_name": "Evil", "redirect_uris": []string{"http://evil.example.com/cb"}}, 400, nil)
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
	if !strings.Contains(string(html), "Allow Test Client to work as you?") {
		t.Fatalf("consent page: %.300s", html)
	}
	field := func(name string) string {
		i := strings.Index(string(html), `name="`+name+`" value="`)
		rest := string(html)[i+len(name)+15:]
		return rest[:strings.Index(rest, `"`)]
	}
	wsID := string(html)[strings.Index(string(html), `<option value="`)+15:]
	wsID = wsID[:strings.Index(wsID, `"`)]
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
	if bad.StatusCode != 400 {
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
		req, _ := http.NewRequest("POST", s.url+"/mcp", strings.NewReader(string(body)))
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
	if len(tools) < 15 || len(tools) > 24 {
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
		req, _ := http.NewRequest("POST", s.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.Header.Set("Authorization", "Bearer "+tok.Access)
		return req
	}())
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("the old token still works after a refresh: %d", resp.StatusCode)
	}
	rpc(next.Access, "ping", nil)
}
