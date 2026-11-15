package server_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestNotFoundAnswersKeepTheirWords asks each handler that answers "not
// found" about a row for one that does not exist, and checks the status and
// the body word for word: what a caller is told about a missing row does
// not depend on how the handler finds out it is missing.
func TestNotFoundAnswersKeepTheirWords(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		bea, _ := s.invitedPerson()
		var other struct{ Slug string }
		s.call(s.owner, "", "POST", "/api/v1/workspaces", M{"name": "Elsewhere"}, 201, &other)

		page := s.change(s.owner, "", "doc.create", M{"title": "Notes", "markdown": "Words."})["ref"].(string)

		const none = "00000000-0000-4000-8000-000000000000"
		cases := []struct {
			name, method, path string
			body               any
			who                *http.Client // nil: the owner
			want               string
		}{
			{"a workspace", "GET", "/api/v1/w/nowhere/me", nil, nil,
				`{"error":{"code":"not_found","message":"workspace nowhere not found"}}`},
			{"a workspace one is not in", "GET", "/api/v1/w/" + other.Slug + "/me", nil, bea,
				`{"error":{"code":"not_found","message":"workspace ` + other.Slug + ` not found"}}`},
			{"a page", "GET", w + "/docs/" + none, nil, nil,
				`{"error":{"code":"not_found","message":"doc ` + none + ` not found"}}`},
			{"a page's version", "GET", w + "/docs/" + page + "/versions/" + none, nil, nil,
				`{"error":{"code":"not_found","message":"version not found"}}`},
			{"a file's record", "GET", w + "/files/" + none, nil, nil,
				`{"error":{"code":"not_found","message":"file not found"}}`},
			{"a file's next part", "PATCH", w + "/files/" + none, []byte("x"), nil,
				`{"error":{"code":"not_found","message":"file not found"}}`},
			{"a file's bytes", "GET", "/f/" + none + "/x.txt", nil, nil,
				`{"error":{"code":"not_found","message":"file not found"}}`},
			{"a file to import", "POST", w + "/import", M{"kind": "linear", "file": none}, nil,
				`{"error":{"code":"not_found","message":"file not found"}}`},
			{"a token", "DELETE", w + "/tokens/" + none, nil, nil,
				`{"error":{"code":"not_found","message":"token not found"}}`},
			{"a source", "POST", w + "/sources/" + none + "/sync", nil, nil,
				`{"error":{"code":"not_found","message":"source not found"}}`},
			{"a cycle", "GET", w + "/cycles/" + none + "/chart", nil, nil,
				`{"error":{"code":"not_found","message":"cycle not found"}}`},
			{"a secret", "POST", w + "/secrets/nothing/request", M{"method": "GET", "url": "https://example.com"}, nil,
				`{"error":{"code":"not_found","message":"secret not found"}}`},
			{"an integration", "POST", w + "/integrations/" + none + "/sync", nil, nil,
				`{"error":{"code":"not_found","message":"integration not found"}}`},
			{"a webhook", "POST", w + "/webhooks/" + none + "/test", nil, nil,
				`{"error":{"code":"not_found","message":"webhook not found"}}`},
			{"an account", "PATCH", "/api/v1/admin/users/" + none, M{}, nil,
				`{"error":{"code":"not_found","message":"user not found"}}`},
			{"a workspace to restore", "POST", "/api/v1/admin/workspaces/" + none + "/restore", nil, nil,
				`{"error":{"code":"not_found","message":"workspace not found"}}`},
			{"a workspace to join", "POST", "/api/v1/admin/workspaces/nowhere/join", nil, nil,
				`{"error":{"code":"not_found","message":"workspace not found"}}`},
			{"a backup", "GET", "/api/v1/admin/backups/" + none + "/download", nil, nil,
				`{"error":{"code":"not_found","message":"backup not found"}}`},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				s := s.in(t)
				hc := s.owner
				if tc.who != nil {
					hc = tc.who
				}
				got := strings.TrimSpace(s.call(hc, "", tc.method, tc.path, tc.body, 404, nil))
				if got != tc.want {
					t.Fatalf("the answer is\n%s\nwant\n%s", got, tc.want)
				}
			})
		}
	})
}
