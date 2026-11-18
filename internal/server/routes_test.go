package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

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
