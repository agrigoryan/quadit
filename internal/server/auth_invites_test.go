package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAnInvitationIsAllowedAsAddingTheMemberWouldBe: inviting someone is
// adding a member, and is allowed exactly as member.add is. A credential or
// a membership that may only read invites nobody; an agent that must ask
// before adding people asks before inviting them; and an invitation made
// with a credential limited to some projects admits the new member to
// those projects only, never as an owner. An approval is spent only on an
// invitation made.
func TestAnInvitationIsAllowedAsAddingTheMemberWouldBe(t *testing.T) {
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := newFaultyStore(plain)
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		admin := func(handle string, scope M) string {
			s.change(s.owner, "", "agent.create", M{"name": handle, "handle": handle, "role": "admin", "scope": scope})
			var out struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@" + handle}, 201, &out)
			return out.Token
		}
		invites := "/api/v1/w/-/invites"

		t.Run("not with a read-only credential", func(t *testing.T) {
			s := s.in(t)
			var ro struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "me", "read_only": true}, 201, &ro)
			s.call(nil, ro.Token, "POST", invites, M{"email": "ro@example.com"}, 403, nil)
		})
		t.Run("not with a read-only membership", func(t *testing.T) {
			s := s.in(t)
			reader := admin("reader", M{"read_only": true, "needs_approval": []string{}})
			s.call(nil, reader, "POST", invites, M{"email": "reader@example.com"}, 403, nil)
		})
		t.Run("with an approval when adding people needs one", func(t *testing.T) {
			s := s.in(t)
			asker := admin("asker", nil) // a new agent asks before adding people
			if out := s.call(nil, asker, "POST", invites, M{"email": "new@example.com"}, 403, nil); !strings.Contains(out, "needs_approval") {
				t.Fatalf("an invitation went out without the approval adding a member needs: %s", out)
			}
			ask := s.change(nil, asker, "decision.open", M{"task": "SVA-1", "kind": "approval", "action": "member.add",
				"args": M{"user": "new@example.com", "role": "member"}, "question": "Invite new@example.com?"})["ref"].(string)
			s.change(s.owner, "", "decision.pick", M{"id": ask, "outcome": "approved"})
			s.call(nil, asker, "POST", invites, M{"email": "other@example.com", "approval": ask}, 403, nil)
			s.call(nil, asker, "POST", invites, M{"email": "new@example.com", "approval": ask}, 201, nil)
			s.call(nil, asker, "POST", invites, M{"email": "new@example.com", "approval": ask}, 403, nil) // an approval is used once
		})
		t.Run("an approval outlives an invitation that could not be made", func(t *testing.T) {
			s := s.in(t)
			asker := admin("retrier", nil)
			ask := s.change(nil, asker, "decision.open", M{"task": "SVA-1", "kind": "approval", "action": "member.add",
				"args": M{"user": "late@example.com", "role": "member"}, "question": "Invite late@example.com?"})["ref"].(string)
			s.change(s.owner, "", "decision.pick", M{"id": ask, "outcome": "approved"})
			fired := st.faults.arm(fault{op: "insert", table: "invites", times: 1})
			s.call(nil, asker, "POST", invites, M{"email": "late@example.com", "approval": ask}, 500, nil)
			if fired() != 1 {
				t.Fatalf("the fault fired %d times", fired())
			}
			s.call(nil, asker, "POST", invites, M{"email": "late@example.com", "approval": ask}, 201, nil)
		})
		t.Run("limited to the projects of the credential", func(t *testing.T) {
			s := s.in(t)
			var limited struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "me", "projects": []string{"SVA"}}, 201, &limited)
			s.call(nil, limited.Token, "POST", invites, M{"role": "owner"}, 403, nil)
			var inv struct{ Link string }
			s.call(nil, limited.Token, "POST", invites, M{"role": "admin"}, 201, &inv)
			token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
			b := browser()
			s.call(b, "", "POST", "/api/v1/auth/invite/"+token, M{"name": "Cy", "email": "cy@example.com", "password": "another-long-password"}, 200, nil)
			s.call(b, "", "GET", w+"/tasks/SVA-1", nil, 200, nil)
			s.call(b, "", "GET", w+"/tasks/OPS-1", nil, 404, nil)
		})
	})
}
