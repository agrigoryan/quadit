package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestGoogleStorageRefusesAnOAuthClientFile: the files setting for Google
// Cloud Storage takes a key the server can sign in with by itself. An OAuth
// client file (an "installed" or "web" app's id and secret, for a consent
// flow) is not one: it is refused when the setting is saved, in words that
// say what was given and what is needed, and so is a key of a kind Google's
// library does not read.
func TestGoogleStorageRefusesAnOAuthClientFile(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	for name, c := range map[string]struct{ key, says string }{
		"an installed app's client": {`{"installed":{"client_id":"1.apps.googleusercontent.com","client_secret":"s","redirect_uris":["http://localhost"]}}`, "OAuth client"},
		"a web app's client":        {`{"web":{"client_id":"1.apps.googleusercontent.com","client_secret":"s"}}`, "OAuth client"},
		"a key of no kind":          {`{"project_id":"p"}`, "has no"},
		"a key of an unknown kind":  {`{"type":"api_key"}`, "api_key"},
	} {
		t.Run(name, func(t *testing.T) {
			out := s.in(t).call(s.owner, "", "PUT", "/api/v1/admin/settings/files", M{"kind": "gcs", "bucket": "quadit-files", "credentials": c.key}, 400, nil)
			if !strings.Contains(out, c.says) || !strings.Contains(out, "service_account") {
				t.Fatalf("the refusal says %s; want it to name what was given (%s) and what is needed (a service account key)", out, c.says)
			}
		})
	}
}
