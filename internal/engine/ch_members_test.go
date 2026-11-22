package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
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

// TestANewMemberGetsTheTintUsedLeast: the first members of a workspace
// each get a tint of their own, in the palette's order; once all are taken
// the one used least comes next, and a removed member's tint is free again.
func TestANewMemberGetsTheTintUsedLeast(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		tints := []int{w.member(w.owner.ID).Tint}
		var agents []string
		for i := range core.MemberTints + 1 {
			a := w.agent(fmt.Sprintf("bot%d", i))
			agents = append(agents, a)
			tints = append(tints, w.member(a).Tint)
		}
		want := []int{1, 2, 3, 4, 5, 6, 7, 8, 1, 2}
		if !slices.Equal(tints, want) {
			t.Fatalf("the tints of the first members are %v, want %v", tints, want)
		}
		// bot2 (tint 4) goes: 4 is used least now, and the next member gets it.
		w.do(w.owner.ID, "member.remove", M{"id": agents[2]})
		if got := w.member(w.agent("late")).Tint; got != 4 {
			t.Fatalf("the member after a removal got tint %d, want 4", got)
		}
	})
}
