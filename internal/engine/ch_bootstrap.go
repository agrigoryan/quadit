// Bootstrap: a new workspace and its owner, made outside any change.

package engine

import (
	"context"
	"errors"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// BootstrapArgs describe a new workspace and the person who owns it.
type BootstrapArgs struct {
	OwnerID       string // an existing user; or the fields below make one
	OwnerName     string
	OwnerEmail    string
	OwnerHandle   string
	WorkspaceSlug string
	WorkspaceName string
}

// Bootstrap makes a workspace and its owner membership, and the owner too
// if they do not exist yet. It is how a new install, or a new workspace on
// one, starts.
func (e *Engine) Bootstrap(ctx context.Context, a BootstrapArgs) (core.Workspace, core.User, error) {
	var ws core.Workspace
	var owner core.User
	at := e.now().UnixMilli()
	if !validSlug(a.WorkspaceSlug) {
		return ws, owner, invalid("workspace_slug", "a slug is 2 to 40 lower-case letters, digits or dashes")
	}
	err := e.st.Atomic(ctx, func(db store.DB) error {
		var err error
		if owner, err = ownerFor(ctx, db, a, at); err != nil {
			return err
		}
		if owner.Kind != core.KindPerson {
			return invalid("owner", "a workspace is owned by a person")
		}
		handle := a.OwnerHandle
		if handle == "" {
			handle = handleFrom(owner.Name, owner.Email)
		}
		if err := checkHandle(handle); err != nil {
			return err
		}
		ws = core.Workspace{ID: id.New(), Slug: a.WorkspaceSlug, Name: strings.TrimSpace(a.WorkspaceName), CreatedAt: at, UpdatedAt: at}
		if ws.Name == "" {
			ws.Name = ws.Slug
		}
		if err := db.Insert(ctx, ws); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return &Error{Code: CodeConflict, Field: "slug", Message: "a workspace with the address \"" + ws.Slug + "\" already exists; choose another"}
			}
			return err
		}
		return db.Insert(ctx, core.Member{WorkspaceID: ws.ID, UserID: owner.ID, Role: core.RoleOwner, Handle: handle,
			Kind: owner.Kind, Name: owner.Name, Avatar: owner.Avatar, CreatedAt: at})
	})
	return ws, owner, err
}

// ownerFor finds the person who will own a new workspace: by id, or by
// email address, making their account when there is none yet.
func ownerFor(ctx context.Context, db store.DB, a BootstrapArgs, at int64) (core.User, error) {
	var owner core.User
	if a.OwnerID != "" {
		return owner, db.Get(ctx, &owner, store.Eq("id", a.OwnerID), store.Live)
	}
	email := strings.ToLower(strings.TrimSpace(a.OwnerEmail))
	if email == "" || !strings.Contains(email, "@") {
		return owner, invalid("owner_email", "an owner needs an email address")
	}
	there, err := store.Find(ctx, db, &owner, store.Eq("email", email), store.Live)
	if err != nil || there {
		return owner, err
	}
	owner = core.User{ID: id.New(), Kind: core.KindPerson, Name: strings.TrimSpace(a.OwnerName), Email: email, CreatedAt: at, UpdatedAt: at}
	if owner.Name == "" {
		return owner, invalid("owner_name", "an owner needs a name")
	}
	// The first person on an install runs it.
	people, err := db.Count(ctx, "users", store.Eq("kind", core.KindPerson))
	if err != nil {
		return owner, err
	}
	owner.IsAdmin = people == 0
	return owner, db.Insert(ctx, owner)
}

// validSlug reports whether a workspace's slug, the name in its address,
// is 2 to 40 lower-case letters, digits and dashes.
func validSlug(s string) bool {
	if len(s) < 2 || len(s) > 40 {
		return false
	}
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}
