package server_test

import (
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestThePersonResponsibleForAnAgentMayMakeItsTokens: who may let a client
// work as an agent by OAuth (the person who answers for it, or an admin)
// may also make it a token, so the desktop app can connect a harness for a
// person who does not run the workspace. Another person's agent, or a
// person, stays theirs.
func TestThePersonResponsibleForAnAgentMayMakeItsTokens(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		bea, beaID := s.invitedPerson(t)
		s.change(t, s.owner, "", "agent.create", M{"name": "Bea's helper", "handle": "beas-helper", "responsible": beaID})
		s.change(t, s.owner, "", "agent.create", M{"name": "Owner's helper", "handle": "owners-helper"})

		t.Run("for an agent they answer for", func(t *testing.T) {
			var made struct{ Token string }
			s.call(t, bea, "", "POST", w+"/tokens", M{"user": "@beas-helper", "name": "Claude Code"}, 201, &made)
			var me struct{ Handle string }
			s.call(t, nil, made.Token, "GET", w+"/me", nil, 200, &me)
			if me.Handle != "@beas-helper" {
				t.Fatalf("the token works as %s", me.Handle)
			}
		})
		t.Run("not for another person's agent", func(t *testing.T) {
			s.call(t, bea, "", "POST", w+"/tokens", M{"user": "@owners-helper"}, 403, nil)
		})
		t.Run("not for a person", func(t *testing.T) {
			var owner struct{ Handle string }
			s.call(t, s.owner, "", "GET", w+"/me", nil, 200, &owner)
			s.call(t, bea, "", "POST", w+"/tokens", M{"user": owner.Handle}, 403, nil)
		})
	})
}
