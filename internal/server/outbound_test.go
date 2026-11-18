package server_test

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAddressesUsersGiveAreReachedOnlyWhenPublic: every address a user
// gives the server to call (a browser's push service, a webhook, a host a
// secret is bound to, a service to import from, a GitHub Enterprise) is
// refused when it is on this machine or its network, by name or by number,
// unless whoever runs the server opened that network. Nothing there is
// even connected to.
func TestAddressesUsersGiveAreReachedOnlyWhenPublic(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSiteWith(t, st, func(*server.Config) {})
		var reached atomic.Int32
		inside := httptest.NewUnstartedServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { rw.WriteHeader(http.StatusCreated) }))
		inside.Config.ConnState = func(_ net.Conn, state http.ConnState) {
			if state == http.StateNew {
				reached.Add(1)
			}
		}
		inside.StartTLS()
		defer inside.Close()
		_, port, _ := net.SplitHostPort(strings.TrimPrefix(inside.URL, "https://"))
		byName := "https://localhost:" + port
		refusedWith := func(t *testing.T, out string) {
			t.Helper()
			if !strings.Contains(out, "private or local address") {
				t.Fatalf("the refusal does not say why: %s", out)
			}
		}

		t.Run("push", func(t *testing.T) {
			browserKey, err := ecdh.P256().GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			secret := make([]byte, 16)
			_, _ = rand.Read(secret)
			keys := M{"p256dh": base64.RawURLEncoding.EncodeToString(browserKey.PublicKey().Bytes()), "auth": base64.RawURLEncoding.EncodeToString(secret)}
			for _, endpoint := range []string{inside.URL + "/push/1", byName + "/push/2"} {
				s.call(t, s.owner, "", "POST", "/api/v1/push/subscriptions", M{"endpoint": endpoint, "keys": keys}, 201, nil)
			}
			s.call(t, s.owner, "", "POST", "/api/v1/push/subscriptions", M{"endpoint": "http://push.example.com/plain", "keys": keys}, 400, nil)
			s.call(t, s.owner, "", "POST", "/api/v1/push/test", nil, 502, nil)
		})
		t.Run("webhook", func(t *testing.T) {
			for _, u := range []string{inside.URL + "/hook", byName + "/hook"} {
				hook := s.change(t, s.owner, "", "webhook.create", M{"url": u})["ref"].(string)
				var res struct {
					OK    bool
					Error string
				}
				s.call(t, s.owner, "", "POST", w+"/webhooks/"+hook+"/test", nil, 200, &res)
				if res.OK {
					t.Fatalf("a webhook to %s was delivered", u)
				}
				refusedWith(t, res.Error)
			}
		})
		t.Run("vault", func(t *testing.T) {
			s.change(t, s.owner, "", "secret.set", M{"name": "INSIDE_KEY", "value": "inside-value-123", "hosts": []string{strings.TrimPrefix(byName, "https://")}})
			var res struct {
				OK    bool
				Error string
			}
			s.call(t, s.owner, "", "POST", w+"/secrets/INSIDE_KEY/request", M{"url": byName + "/x", "headers": M{"Authorization": "Bearer {{secret}}"}}, 200, &res)
			if res.OK {
				t.Fatal("the vault called a host on this machine")
			}
			refusedWith(t, res.Error)
		})
		t.Run("import", func(t *testing.T) {
			out := s.call(t, s.owner, "", "POST", w+"/import", M{"kind": "orbit", "source": byName, "options": M{"workspace": "ws1", "token": "t"}, "dry_run": true}, 400, nil)
			refusedWith(t, out)
			out = s.call(t, s.owner, "", "POST", w+"/import", M{"kind": "github", "source": "acme/game", "options": M{"api": byName}, "dry_run": true}, 400, nil)
			refusedWith(t, out)
		})
		t.Run("github integration", func(t *testing.T) {
			in := s.change(t, s.owner, "", "integration.create", M{"kind": "github", "secret": "ghp_x", "config": M{"repo": "acme/game", "api_url": byName}})["ref"].(string)
			out := s.call(t, s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 409, nil)
			refusedWith(t, out)
		})
		if n := reached.Load(); n != 0 {
			t.Fatalf("the server opened %d connections to a server on this machine", n)
		}
	})
}
