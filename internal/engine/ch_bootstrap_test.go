package engine_test

import (
	"context"
	"errors"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestBootstrapMakesAnOwnerWithNoEmail: an owner given no email address is
// a person without one (the owner of an install the desktop app sets up),
// as many as are made; an address that is given must be one, and finds the
// account that has it.
func TestBootstrapMakesAnOwnerWithNoEmail(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		e := engine.New(st, nil)
		slug := func() string { u := id.New(); return "w" + u[len(u)-12:] }

		ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram Grigoryan", WorkspaceSlug: slug(), WorkspaceName: "Personal"})
		if err != nil {
			t.Fatal(err)
		}
		if owner.Email != "" || owner.Kind != core.KindPerson || owner.Name != "Aram Grigoryan" {
			t.Fatalf("the owner is %+v", owner)
		}
		var m core.Member
		if err := st.In(ws.ID).Get(ctx, &m, store.Eq("user_id", owner.ID)); err != nil || m.Role != core.RoleOwner || m.Handle != "aram-grigoryan" {
			t.Fatalf("the owner's membership is %+v (%v)", m, err)
		}

		t.Run("another without one", func(t *testing.T) {
			if _, other, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Bea", WorkspaceSlug: slug(), WorkspaceName: "Bea's"}); err != nil || other.ID == owner.ID {
				t.Fatalf("a second owner with no email: %+v, %v", other, err)
			}
		})

		t.Run("an address that is not one", func(t *testing.T) {
			_, _, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Cy", OwnerEmail: "cy", WorkspaceSlug: slug(), WorkspaceName: "Cy's"})
			var refusal *engine.Error
			if !errors.As(err, &refusal) || refusal.Field != "owner_email" {
				t.Fatalf("an owner with the email %q: %v", "cy", err)
			}
		})

		t.Run("an address of an account", func(t *testing.T) {
			email := "dee-" + id.New() + "@example.com"
			_, first, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Dee", OwnerEmail: email, WorkspaceSlug: slug(), WorkspaceName: "Dee's"})
			if err != nil {
				t.Fatal(err)
			}
			_, again, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Dee", OwnerEmail: email, WorkspaceSlug: slug(), WorkspaceName: "Dee's second"})
			if err != nil || again.ID != first.ID {
				t.Fatalf("the same address made %+v (%v), want %s", again, err, first.ID)
			}
		})
	})
}
