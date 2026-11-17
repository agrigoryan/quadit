package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTheVersionSaysWhatTheServerIs: anyone may ask, without signing in,
// whether an address is a Quadit server, which version, which agent surface
// and which desktop sign-in hand-off it speaks; the desktop app asks before
// it adds a server.
func TestTheVersionSaysWhatTheServerIs(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	var v struct {
		Name    string
		Version string
		Surface string
		Desktop struct{ Handoff int }
	}
	s.call(nil, "", "GET", "/api/v1/version", nil, 200, &v)
	if v.Name != "quadit" || v.Version != "test" || v.Surface != engine.Surface || v.Desktop.Handoff != 1 {
		t.Fatalf("version = %+v", v)
	}
}

// TestTheLicensesAreServed: /licenses gives Quadit's own license and the
// notices of the work of others it contains, to anyone.
func TestTheLicensesAreServed(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		text := s.call(nil, "", "GET", "/licenses", nil, 200, nil)
		for _, want := range []string{"MIT License", "THIRD-PARTY NOTICES FOR QUADIT", "github.com/jackc/pgx/v5", "@blocknote/core", "Mozilla Public License"} {
			if !strings.Contains(text, want) {
				t.Errorf("/licenses does not say %q", want)
			}
		}
	})
}
