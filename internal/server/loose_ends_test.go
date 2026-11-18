package server_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestDecisionLogHasTheFiles: the decision log carries the files on each
// question and on each of its options, as the task does, in JSON and text.
func TestDecisionLogHasTheFiles(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss exit"})
		agent := s.agentToken(t, "coder")
		f := someFiles(t, "context.png", "a.gif", "b.gif", "exit.png")
		if out, code := s.quadit(t, agent, "ask", "SVA-1", "Which arrival?", "file="+f["context.png"],
			"option=A", "file="+f["a.gif"], "option=B", "file="+f["b.gif"]); code != 0 {
			t.Fatalf("ask: %d %s", code, out)
		}
		if out, code := s.quadit(t, agent, "ask", "SVA-2", "Which exit?", "option=Left", "file="+f["exit.png"], "option=Right"); code != 0 {
			t.Fatalf("ask: %d %s", code, out)
		}

		var log struct {
			Decisions []struct {
				Question    string
				Attachments []struct{ Name, URL string }
				Options     []struct {
					Attachments []struct{ Name, URL string }
				}
			}
		}
		s.call(t, nil, agent, "GET", "/api/v1/w/-/decisions?state=all", nil, 200, &log)
		got := map[string]string{}
		for _, d := range log.Decisions {
			files := []string{fileNames(d.Attachments)}
			for _, o := range d.Options {
				files = append(files, fileNames(o.Attachments))
			}
			got[d.Question] = strings.Join(files, "|")
		}
		if got["Which arrival?"] != "context.png|a.gif|b.gif" || got["Which exit?"] != "|exit.png|" {
			t.Fatalf("files in the log (question|option 1|option 2): %q", got)
		}

		text := s.call(t, nil, agent, "GET", "/api/v1/w/-/decisions?state=all&format=text", nil, 200, nil)
		for _, want := range []string{"file: context.png " + s.url + "/f/", "option 1 file: a.gif " + s.url + "/f/",
			"option 2 file: b.gif ", "option 1 file: exit.png "} {
			if !strings.Contains(text, want) {
				t.Errorf("the log in text has no %q:\n%s", want, text)
			}
		}
	})
}

// standIn serves a provider made by routes, except that a request to the
// path hang gets no answer until the asker gives up (or long after the
// time it has).
func standIn(t *testing.T, hang string, routes func(mux *http.ServeMux, base string)) *httptest.Server {
	mux := http.NewServeMux()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == hang {
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	routes(mux, srv.URL)
	return srv
}

// openIDRoutes is an OpenID Connect provider that signs in whoever asks.
func openIDRoutes(mux *http.ServeMux, base string) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(M{"issuer": base, "authorization_endpoint": base + "/auth", "token_endpoint": base + "/token",
			"jwks_uri": base + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		http.Redirect(w, r, q.Get("redirect_uri")+"?state="+url.QueryEscape(q.Get("state"))+"&code="+url.QueryEscape(q.Get("nonce")), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		now := time.Now()
		raw, _ := jwt.Signed(signer).Claims(M{"iss": base, "sub": "slow-1", "aud": "quadit-client", "exp": now.Add(time.Hour).Unix(),
			"iat": now.Unix(), "nonce": r.Form.Get("code"), "email": "slow@example.com", "email_verified": true}).Serialize()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(M{"access_token": "at", "token_type": "Bearer", "id_token": raw, "expires_in": 3600})
	})
}

// gitHubRoutes is GitHub's sign-in and the two questions asked of its API.
func gitHubRoutes(mux *http.ServeMux, base string) {
	mux.HandleFunc("/login/oauth/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		http.Redirect(w, r, q.Get("redirect_uri")+"?code=the-code&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
	})
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"gho_fake123","token_type":"bearer","scope":"read:user,user:email"}`))
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(M{"id": 7, "login": "slow"})
	})
	mux.HandleFunc("/user/emails", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]M{{"email": "slow@example.com", "primary": true, "verified": true}})
	})
}

// TestSignInGivesUpOnASilentProvider: whichever request of a sign-in the
// provider leaves unanswered (where it lives, the token, its keys, who
// signed in), the sign-in gives up within the limit and the person is told
// the provider could not confirm who they are.
func TestSignInGivesUpOnASilentProvider(t *testing.T) {
	was := *server.GitHubTimeout
	*server.GitHubTimeout = 300 * time.Millisecond
	t.Cleanup(func() { *server.GitHubTimeout = was })
	couldNot := "/login?error=" + url.QueryEscape("The provider could not confirm who you are.")
	cases := []struct {
		provider, hang string
		routes         func(*http.ServeMux, string)
	}{
		{"oidc", "", openIDRoutes},
		{"oidc", "/.well-known/openid-configuration", openIDRoutes},
		{"oidc", "/token", openIDRoutes},
		{"oidc", "/keys", openIDRoutes},
		{"github", "", gitHubRoutes},
		{"github", "/login/oauth/access_token", gitHubRoutes},
		{"github", "/user/emails", gitHubRoutes},
	}
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		for _, c := range cases {
			p := standIn(t, c.hang, c.routes)
			setting := M{"enabled": true, "name": "Slow", "issuer": p.URL, "client_id": "quadit-client", "client_secret": "s3cret"}
			if c.provider == "github" {
				setting = M{"enabled": true, "client_id": "Iv1.abc", "client_secret": "s3cret",
					"auth_url": p.URL + "/login/oauth/authorize", "token_url": p.URL + "/login/oauth/access_token", "api_url": p.URL}
			}
			s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth."+c.provider, setting, 200, nil)
			b := browser()
			b.Timeout = 10 * time.Second
			start := time.Now()
			resp, err := b.Get(s.url + "/api/v1/auth/oauth/" + c.provider + "/start")
			if err != nil {
				t.Errorf("%s, silent at %q: the sign-in did not end: %v", c.provider, c.hang, err)
				continue
			}
			resp.Body.Close()
			got, took := resp.Request.URL.RequestURI(), time.Since(start)
			switch {
			case c.hang == "" && (got == couldNot || !strings.HasPrefix(got, "/login?error=")):
				// Nobody is invited, so a sign-in that works is turned away,
				// but for another reason.
				t.Errorf("%s answering everything: sign-in ended at %s", c.provider, got)
			case c.hang != "" && got != couldNot:
				t.Errorf("%s, silent at %s: sign-in ended at %s after %s, want %s", c.provider, c.hang, got, took, couldNot)
			case took > 3*time.Second:
				t.Errorf("%s, silent at %q: the sign-in waited %s", c.provider, c.hang, took)
			}
		}
	})
}

// TestSyncKeepsFrontMatter: a page whose file opens with front matter is
// edited here, below the front matter; written back, the file changes in
// that line only, and its front matter comes back byte for byte, in each
// of three styles.
func TestSyncKeepsFrontMatter(t *testing.T) {
	files := map[string]string{
		"docs/plain.md":  "---\nowner: aram\nstatus:   draft\n---\n\n# Plain\n\nText.\n",
		"docs/quoted.md": "---\ntitle: \"Boss: the return\"\nwhen: '10:30'\nnote: \"*not* emphasis\"\n---\nText.\n",
		"docs/list.md":   "---\ntags:\n  - vfx\n  - boss_fight\nweight: 2\n---\n\n# Listed\n\nText.\n",
	}
	s := newSite(t, testdb.SQLite(t))
	r := newSyncedRepo(t, s, files)
	r.src = s.change(t, s.owner, "", "source.create", M{"title": "Game docs", "repo": r.origin, "subdir": "docs"})["ref"].(string)
	if res := r.sync(); res.PagesCreated != 3 {
		t.Fatalf("first sync: %+v", res)
	}
	r.idle("after the first sync")
	for _, title := range []string{"Plain", "quoted", "Listed"} {
		page := s.pageID(t, title)
		text := s.call(t, s.owner, "", "GET", w+"/docs/"+page+"?format=md", nil, 200, nil)
		if !strings.Contains(text, "Text.") {
			t.Fatalf("page %s: %q", title, text)
		}
		s.change(t, s.owner, "", "doc.write", M{"doc": page, "markdown": strings.Replace(text, "Text.", "Text two.", 1)})
	}
	if res := r.sync(); res.FilesWritten != 3 {
		t.Fatalf("page edits: %+v", res)
	}
	for path, was := range files {
		if got, want := r.read("main", path), strings.Replace(was, "Text.", "Text two.", 1); got != want {
			t.Errorf("%s after its page was edited:\n%q\nwant\n%q", path, got, want)
		}
	}
	r.idle("after the page edits")
}

// TestDashboardOfOneProjectShowsAgentsThere: narrowed to one project, the
// dashboard still lists every agent, but shows each one working, and its
// last action, only from that project.
func TestDashboardOfOneProjectShowsAgentsThere(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
	s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
	s.change(t, s.owner, "", "agent.create", M{"name": "Clerk", "handle": "clerk"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
	token := func(handle string) string {
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@" + handle}, 201, &tok)
		return tok.Token
	}
	artist, clerk := token("artist"), token("clerk")
	s.change(t, nil, artist, "session.start", M{"task": "SVA-1", "title": "Drawing the boss"})
	s.change(t, nil, artist, "comment.create", M{"task": "SVA-1", "body": "Sketched."})
	s.change(t, nil, clerk, "session.start", M{"title": "Tidying up"})

	type agent struct {
		Handle, State, Task, Doing string
		LastAction                 string `json:"last_action"`
	}
	agents := func(query string) map[string]agent {
		var out struct{ Agents []agent }
		s.call(t, s.owner, "", "GET", w+"/dashboard"+query, nil, 200, &out)
		by := map[string]agent{}
		for _, a := range out.Agents {
			by[a.Handle] = a
		}
		return by
	}
	if got := agents("")["@artist"]; got.State != "working" || got.Task != "SVA-1" || got.LastAction != "comment.create SVA-1" {
		t.Fatalf("the whole dashboard: %+v", got)
	}
	if got := agents("?project=SVA")["@artist"]; got.State != "working" || got.Task != "SVA-1" || got.LastAction != "comment.create SVA-1" {
		t.Fatalf("the dashboard of SVA: %+v", got)
	}
	ops := agents("?project=OPS")
	if len(ops) != 2 {
		t.Fatalf("the dashboard of OPS lists %+v, want both agents", ops)
	}
	for _, a := range ops {
		if a.State == "working" || a.Task != "" || a.Doing != "" || a.LastAction != "" {
			t.Errorf("the dashboard of OPS shows what %s does elsewhere: %+v", a.Handle, a)
		}
	}
}
