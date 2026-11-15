package engine

import (
	"encoding/json"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("workspace.update", core.RoleAdmin, workspaceUpdate)
	register("workspace.delete", core.RoleOwner, workspaceDelete)
}

type workspaceUpdateArgs struct {
	Name     Opt[string]          `json:"name"`
	Icon     Opt[string]          `json:"icon"`
	Settings Opt[json.RawMessage] `json:"settings"`
}

func workspaceUpdate(c *cx, a workspaceUpdateArgs) error {
	var w core.Workspace
	if err := c.tx.Get(c.ctx, &w, store.Eq("id", c.ws)); err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &w.Name); err != nil {
		return err
	}
	p.setText("icon", a.Icon, &w.Icon)
	if a.Settings.Set {
		if !json.Valid(a.Settings.V) {
			return invalid("settings", "settings must be a JSON object")
		}
		p.put("settings", string(w.Settings), string(a.Settings.V))
	}
	if p.empty() {
		return nil
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "workspaces", p.set, store.Eq("id", c.ws)); err != nil {
		return err
	}
	return c.emit(event{seq: seq, typ: "workspace.updated", entity: "workspace", entityID: c.ws, place: inWorkspace(c.ws), data: map[string]any{"id": c.ws, "changes": p.changes}})
}

type workspaceDeleteArgs struct {
	// Confirm must be the workspace's slug, so nothing deletes one by accident.
	Confirm string `json:"confirm"`
}

// workspaceDelete puts the whole workspace in the trash. Nobody can enter
// it from then on; the people who run the install can bring it back for 30
// days, after which it and its files are removed for good.
func workspaceDelete(c *cx, a workspaceDeleteArgs) error {
	var w core.Workspace
	if err := c.tx.Get(c.ctx, &w, store.Eq("id", c.ws)); err != nil {
		return err
	}
	if a.Confirm != w.Slug {
		return invalid("confirm", "to delete this workspace, send its slug as confirm: %q", w.Slug)
	}
	if c.actor.Kind != core.KindPerson {
		return forbidden("only a person who owns the workspace can delete it")
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "workspaces", map[string]any{"deleted_at": c.at}, store.Eq("id", c.ws)); err != nil {
		return err
	}
	c.ref = w.ID
	return c.emit(event{seq: seq, typ: "workspace.deleted", entity: "workspace", entityID: w.ID, place: inWorkspace(w.ID), data: map[string]any{"id": w.ID, "gone": true, "slug": w.Slug}})
}
