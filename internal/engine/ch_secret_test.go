package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestASecretIsNeverStoredPlain: an engine made without a way to seal
// secrets refuses to keep one, rather than keep it as it was sent.
func TestASecretIsNeverStoredPlain(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		for _, ch := range []struct {
			typ  string
			args M
		}{
			{"secret.set", M{"name": "GITHUB_TOKEN", "value": "ghp_plain"}},
			{"integration.create", M{"kind": "github", "secret": "ghp_plain"}},
		} {
			if _, err := w.try(w.owner.ID, ch.typ, ch.args); err == nil {
				t.Errorf("%s: kept a secret with nothing to seal it", ch.typ)
			}
		}
		var secrets []core.Secret
		var integrations []core.Integration
		if err := w.db().List(context.Background(), &secrets, store.Q{}); err != nil {
			t.Fatal(err)
		}
		if err := w.db().List(context.Background(), &integrations, store.Q{}); err != nil {
			t.Fatal(err)
		}
		if len(secrets)+len(integrations) != 0 {
			t.Fatalf("stored: %+v %+v", secrets, integrations)
		}
	})
}
