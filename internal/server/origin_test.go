package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestWritesWithTheCookieComeOnlyFromTheServersOwnPages: a browser sends
// the session cookie with requests any page makes, a page of a sibling
// site (another.example.com beside quadit.example.com) among them. A write
// is taken from the server's own pages only: the browser says so
// (Sec-Fetch-Site), or else the page's origin is the server's address. A
// write that carries the cookie and shows neither is refused, and a JSON
// write made with the cookie must say it is JSON. A token is not sent by
// the browser on its own, so a request made with one is not held to this.
func TestWritesWithTheCookieComeOnlyFromTheServersOwnPages(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "script"}, 201, &tok)
		elsewhere := strings.Replace(s.url, "localhost", "evil.localhost", 1)
		bare := &http.Client{Jar: s.owner.Jar} // the owner's cookie, and no header a browser would add
		send := func(t *testing.T, hc *http.Client, path string, body any, headers map[string]string) (int, string) {
			t.Helper()
			raw, _ := json.Marshal(body)
			req, _ := http.NewRequest(http.MethodPost, s.url+path, bytes.NewReader(raw))
			for k, v := range headers {
				req.Header.Set(k, v)
			}
			resp, err := hc.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			out, _ := io.ReadAll(resp.Body)
			return resp.StatusCode, string(out)
		}
		project := func() any {
			return M{"id": id.New(), "type": "project.create", "args": M{"key": "P" + strings.ToUpper(id.New()[len(id.New())-4:]), "name": "x"}}
		}
		const jsonType = "application/json"

		for _, c := range []struct {
			name    string
			headers map[string]string
			want    int
		}{
			{"from the server's own page", map[string]string{"Sec-Fetch-Site": "same-origin", "Content-Type": jsonType}, 200},
			{"from a sibling site's page", map[string]string{"Sec-Fetch-Site": "same-site", "Content-Type": jsonType}, 403},
			{"from another site's page", map[string]string{"Sec-Fetch-Site": "cross-site", "Content-Type": jsonType}, 403},
			{"an older browser, from the server's own page", map[string]string{"Origin": s.url, "Content-Type": jsonType}, 200},
			{"an older browser, from another site", map[string]string{"Origin": elsewhere, "Content-Type": jsonType}, 403},
			{"an older browser, from a sandboxed page", map[string]string{"Origin": "null", "Content-Type": jsonType}, 403},
			{"an older browser that sends only the page", map[string]string{"Referer": s.url + "/games/tasks", "Content-Type": jsonType}, 200},
			{"an older browser that sends only another site's page", map[string]string{"Referer": elsewhere + "/x", "Content-Type": jsonType}, 403},
			{"a browser that shows nothing of where it comes from", map[string]string{"Content-Type": jsonType}, 403},
			{"the browser's own page, not saying it is JSON", map[string]string{"Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain"}, 400},
			{"the browser's own page, saying nothing of what it sends", map[string]string{"Sec-Fetch-Site": "same-origin"}, 400},
		} {
			t.Run(c.name, func(t *testing.T) {
				if code, out := send(t, bare, w+"/changes", project(), c.headers); code != c.want {
					t.Fatalf("status %d, want %d: %s", code, c.want, out)
				}
			})
		}

		t.Run("a token is not the browser's to send", func(t *testing.T) {
			if code, out := send(t, http.DefaultClient, w+"/changes", project(), map[string]string{"Authorization": "Bearer " + tok.Token, "Sec-Fetch-Site": "cross-site"}); code != 200 {
				t.Fatalf("status %d: %s", code, out)
			}
		})
		t.Run("signing in is a write too", func(t *testing.T) {
			login := M{"email": "owner@example.com", "password": "correct-horse-battery"}
			if code, out := send(t, http.DefaultClient, "/api/v1/auth/login", login, map[string]string{"Sec-Fetch-Site": "cross-site", "Content-Type": jsonType}); code != 403 {
				t.Fatalf("another site signed the browser in: %d %s", code, out)
			}
			if code, out := send(t, http.DefaultClient, "/api/v1/auth/login", login, map[string]string{"Origin": elsewhere, "Content-Type": jsonType}); code != 403 {
				t.Fatalf("another site signed an older browser in: %d %s", code, out)
			}
			// A script with no cookie and no browser around it signs in as before.
			if code, out := send(t, http.DefaultClient, "/api/v1/auth/login", login, nil); code != 200 {
				t.Fatalf("a script's sign-in: %d %s", code, out)
			}
		})
	})
}
