package server_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestSignInDoesNotTakeAnOutageForARefusal checks that when the database
// fails while the server finds who is asking and in which workspace, the
// caller is told the server failed (500), not that their token, session
// or workspace is not valid (401, 404): a database outage is never
// answered as "not found".
func TestSignInDoesNotTakeAnOutageForARefusal(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		token := s.agentToken("bot")

		// Each case makes one kind of row unreadable and calls the API.
		cases := []struct {
			name   string
			fail   func(t *testing.T)
			client *http.Client
			token  string
		}{
			{"the token", func(t *testing.T) { failGet(t, fs, core.APIToken{}) }, nil, token},
			{"the token's account", func(t *testing.T) { failGet(t, fs, core.User{}) }, nil, token},
			{"the session", func(t *testing.T) { failGet(t, fs, core.Session{}) }, s.owner, ""},
			{"the session's account", func(t *testing.T) { failGet(t, fs, core.User{}) }, s.owner, ""},
			{"the workspace", func(t *testing.T) { failGet(t, fs, core.Workspace{}) }, nil, token},
			{"the membership", func(t *testing.T) { failGet(t, fs, core.Member{}) }, nil, token},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				parent := s.t
				s.t = t // call reports to this case
				defer func() { s.t = parent }()
				tc.fail(t)
				body := s.call(tc.client, tc.token, "GET", w+"/me", nil, 500, nil)
				if !strings.Contains(body, `"code":"internal"`) {
					t.Fatalf("the answer is not the server's own failure: %s", body)
				}
			})
		}
	})
}
