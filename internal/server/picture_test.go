package server_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/picture"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAPictureShowsOnlyWhatTheCallerMayRead: the browser that takes a
// picture signs in as the caller with the caller's whole reach: the
// workspace, the projects its credential is limited to, and reading only.
// What it is sent to is a page of the workspace the caller may read.
func TestAPictureShowsOnlyWhatTheCallerMayRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		var targets []string
		s := newSiteWith(t, st, func(cfg *server.Config) {
			cfg.TakePicture = func(_ context.Context, p picture.Request) ([]byte, int, error) {
				targets = append(targets, p.Target)
				return []byte("png"), 0, nil
			}
		})
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		s.call(s.owner, "", "POST", "/api/v1/workspaces", M{"name": "Elsewhere", "slug": "elsewhere"}, 201, nil)
		var limited struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "me", "projects": []string{"SVA"}}, 201, &limited)

		t.Run("the browser reads as the caller does", func(t *testing.T) {
			s := s.in(t)
			s.call(nil, limited.Token, "GET", "/api/v1/w/-/render?task=SVA-1", nil, 200, nil)
			b := browser()
			resp, err := b.Get(targets[len(targets)-1]) // signs the browser in, and sends it to the page
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			s.call(b, "", "GET", w+"/tasks/SVA-1", nil, 200, nil)
			s.call(b, "", "GET", w+"/tasks/OPS-1", nil, 404, nil)
			s.call(b, "", "GET", "/api/v1/w/elsewhere/bootstrap", nil, 403, nil)
			s.call(b, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.update", "args": M{"id": "SVA-1", "title": "x"}}, 403, nil)
		})
		t.Run("only of a page the caller may read", func(t *testing.T) {
			s := s.in(t)
			before := len(targets)
			s.call(nil, limited.Token, "GET", "/api/v1/w/-/render?task=OPS-1", nil, 404, nil)
			s.call(nil, limited.Token, "GET", "/api/v1/w/-/render?path=task/OPS-1", nil, 404, nil)
			for _, path := range []string{"../elsewhere", "..%2F..%2Fapi%2Fv1%2Fauth%2Fme", "//evil.example/x", "task/../../elsewhere", "%25"} {
				s.call(nil, limited.Token, "GET", "/api/v1/w/-/render?path="+path, nil, 400, nil)
			}
			if len(targets) != before {
				t.Fatalf("pictures were taken of what the caller may not read: %v", targets[before:])
			}
			s.call(nil, limited.Token, "GET", "/api/v1/w/-/render?path=tasks", nil, 200, nil)
		})
	})
}
