package engine

import (
	"encoding/json"

	"github.com/agrigoryan/quadit/internal/core"
)

func init() {
	register("integration.create", core.RoleAdmin, integrationCreate)
	register("integration.update", core.RoleAdmin, integrationUpdate)
	register("integration.delete", core.RoleAdmin, integrationDelete)
}

type integrationArgs struct {
	ID      string               `json:"id"`
	Kind    string               `json:"kind"` // github
	Name    Opt[string]          `json:"name"`
	Project Opt[string]          `json:"project"`
	Config  Opt[json.RawMessage] `json:"config"`
	// Secret is the service's token. It is stored encrypted, used by the
	// server, and never returned.
	Secret Opt[string] `json:"secret"`
	Active Opt[bool]   `json:"active"`
}

var integrationKinds = []string{"github"}

func integrationCreate(c *cx, a integrationArgs) error {
	iid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if !contains(integrationKinds, a.Kind) {
		return oneOf("kind", "integration", a.Kind, integrationKinds)
	}
	in := core.Integration{ID: iid, WorkspaceID: c.ws, Kind: a.Kind, Name: a.Name.V, Config: a.Config.V, Active: !a.Active.Set || a.Active.V,
		CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if a.Project.V != "" {
		p, err := c.project(a.Project.V)
		if err != nil {
			return err
		}
		in.ProjectID = p.ID
	}
	if a.Secret.V != "" {
		if in.Secret, err = Seal(a.Secret.V); err != nil {
			return err
		}
		in.HasSecret = true
	}
	seq := c.tx.NextSeq()
	in.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, in); err != nil {
		return alreadyInUse(err, "id", iid)
	}
	return c.created(seq, "integration", in.ID, inWorkspace(c.ws), in)
}

func integrationUpdate(c *cx, a integrationArgs) error {
	in, err := loadLive[core.Integration](c, "integration", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.setText("name", a.Name, &in.Name)
	if a.Project.Set {
		pid := ""
		if a.Project.V != "" {
			pr, err := c.project(a.Project.V)
			if err != nil {
				return err
			}
			pid = pr.ID
		}
		p.put("project_id", in.ProjectID, pid)
	}
	if a.Config.Set && string(a.Config.V) != string(in.Config) {
		p.set["config"] = a.Config.V
		p.changes["config"] = core.FieldChange{From: in.Config, To: a.Config.V}
	}
	if a.Secret.Set {
		sealed := ""
		if a.Secret.V != "" {
			if sealed, err = Seal(a.Secret.V); err != nil {
				return err
			}
		}
		p.set["secret"] = sealed
		p.changes["has_secret"] = core.FieldChange{To: sealed != ""}
	}
	p.setFlag("active", a.Active, &in.Active)
	return c.save(p, target{table: "integrations", entity: "integration", id: in.ID, place: inWorkspace(c.ws)})
}

func integrationDelete(c *cx, a idArgs) error {
	in, err := loadLive[core.Integration](c, "integration", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash(target{table: "integrations", entity: "integration", id: in.ID, place: inWorkspace(c.ws)})
}
