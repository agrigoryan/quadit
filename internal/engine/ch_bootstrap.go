// Bootstrap: a new workspace and its owner, made outside any change.

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// BootstrapArgs describe a new workspace and the person who owns it.
type BootstrapArgs struct {
	OwnerID   string // an existing user; or the fields below make one
	OwnerName string
	// OwnerEmail finds the account that has it, or is the new person's.
	// Empty makes a person with no email address, as an agent has none: the
	// owner of an install the desktop app sets up, who signs in through it.
	OwnerEmail    string
	OwnerHandle   string
	WorkspaceSlug string
	WorkspaceName string
	// Samples starts the workspace with the samples (samples.add, made by
	// the owner, the third for nobody): an install's first workspace has
	// them, one made later starts empty.
	Samples bool
	// Also, when set, writes more in the same transaction once the
	// workspace and its owner are made: what must not be there without
	// them, nor they without it. Its error undoes all of it.
	Also func(ctx context.Context, db store.DB, owner core.User) error
}

// Bootstrap makes a workspace and its owner membership, and the owner too
// if they do not exist yet. It is how a new install, or a new workspace on
// one, starts.
func (e *Engine) Bootstrap(ctx context.Context, a BootstrapArgs) (core.Workspace, core.User, error) {
	var owner core.User
	at := e.now().UnixMilli()
	if !validSlug(a.WorkspaceSlug) {
		return core.Workspace{}, owner, invalid("workspace_slug", "a slug is 2 to 40 lower-case letters, digits or dashes")
	}
	ws := core.Workspace{ID: id.New(), Slug: a.WorkspaceSlug, Name: strings.TrimSpace(a.WorkspaceName), CreatedAt: at, UpdatedAt: at}
	if ws.Name == "" {
		ws.Name = ws.Slug
	}
	var seq int64
	written := false // the workspace is in, and what goes with it is being written
	err := e.st.CreateWorkspace(ctx, ws, func(tx store.Tx) error {
		written = true
		var err error
		if owner, err = ownerFor(ctx, tx, a, at); err != nil {
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
		if err := tx.Insert(ctx, core.Member{WorkspaceID: ws.ID, UserID: owner.ID, Role: core.RoleOwner, Handle: handle,
			Kind: owner.Kind, Name: owner.Name, Avatar: owner.Avatar, CreatedAt: at}); err != nil {
			return err
		}
		if a.Samples {
			run, err := e.startBatch(ctx, newMemoTx(tx), Actor{UserID: owner.ID})
			if err != nil {
				return err
			}
			if _, err := run.apply(Change{ID: id.New(), Type: "samples.add", Args: json.RawMessage(`{}`)}); err != nil {
				return err
			}
		}
		seq = tx.Seq()
		if a.Also == nil {
			return nil
		}
		return a.Also(ctx, tx, owner)
	})
	if !written && errors.Is(err, store.ErrConflict) {
		return ws, owner, &Error{Code: CodeConflict, Field: "slug", Message: "a workspace with the address \"" + ws.Slug + "\" already exists; choose another"}
	}
	if err == nil && e.OnCommit != nil {
		e.OnCommit(ws.ID, seq)
	}
	return ws, owner, err
}

// ownerFor finds the person who will own a new workspace: by id, or by
// email address, making their account when there is none yet (or no
// address is given).
func ownerFor(ctx context.Context, db store.DB, a BootstrapArgs, at int64) (core.User, error) {
	var owner core.User
	if a.OwnerID != "" {
		return owner, db.Get(ctx, &owner, store.Eq("id", a.OwnerID), store.Live)
	}
	email := strings.ToLower(strings.TrimSpace(a.OwnerEmail))
	if email != "" {
		if !strings.Contains(email, "@") {
			return owner, invalid("owner_email", "that is not an email address")
		}
		there, err := store.Find(ctx, db, &owner, store.Eq("email", email), store.Live)
		if err != nil || there {
			return owner, err
		}
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
