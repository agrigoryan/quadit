package engine_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestNobodyAddsAMemberWhoReachesFurtherThanThey: a member added with a
// credential limited to some projects is limited to those projects, and
// such a credential cannot make an owner, who reaches every project.
func TestNobodyAddsAMemberWhoReachesFurtherThanThey(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		sva := w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		person := func(name string) core.User {
			u := core.User{ID: id.New(), Kind: core.KindPerson, Name: name, Email: name + "-" + id.New() + "@example.com", CreatedAt: 1, UpdatedAt: 1}
			if err := st.Insert(ctx, u); err != nil {
				t.Fatal(err)
			}
			return u
		}
		limited := engine.Actor{UserID: w.owner.ID, Projects: []string{sva}}
		add := func(args M) error {
			raw, _ := json.Marshal(args)
			_, err := w.e.Apply(ctx, w.ws.ID, limited, engine.Change{ID: id.New(), Type: "member.add", Args: raw})
			return err
		}

		mia := person("Mia")
		if err := add(M{"user": mia.ID, "handle": "mia", "role": "admin"}); err != nil {
			t.Fatal(err)
		}
		var m core.Member
		if err := w.db().Get(ctx, &m, store.Eq("user_id", mia.ID)); err != nil {
			t.Fatal(err)
		}
		if m.Scope == nil || !slices.Equal(m.Scope.Projects, []string{sva}) {
			t.Fatalf("a member added with a credential limited to SVA reaches %+v", m.Scope)
		}
		if err := add(M{"user": person("Olu").ID, "handle": "olu", "role": "owner"}); err == nil {
			t.Fatal("a credential limited to one project made an owner")
		}
	})
}
