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
		if a.OwnerID != "" {
			err = db.Get(ctx, &owner, store.Eq("id", a.OwnerID), store.Live)
		} else {
			email := strings.ToLower(strings.TrimSpace(a.OwnerEmail))
			if email == "" || !strings.Contains(email, "@") {
				return invalid("owner_email", "an owner needs an email address")
			}
			err = db.Get(ctx, &owner, store.Eq("email", email), store.Live)
			if errors.Is(err, store.ErrNotFound) {
				owner = core.User{ID: id.New(), Kind: core.KindPerson, Name: strings.TrimSpace(a.OwnerName), Email: email, CreatedAt: at, UpdatedAt: at}
				if owner.Name == "" {
					return invalid("owner_name", "an owner needs a name")
				}
				// The first person on an install runs it.
				if n, cerr := db.Count(ctx, "users", store.Eq("kind", core.KindPerson)); cerr == nil && n == 0 {
					owner.IsAdmin = true
				}
				err = db.Insert(ctx, owner)
			}
		}
		if err != nil {
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
