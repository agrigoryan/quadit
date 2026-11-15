package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("label.create", core.RoleMember, labelCreate)
	// Anyone tags with a new label; renaming or removing one changes it for
	// everybody, which is an admin's call.
	register("label.update", core.RoleAdmin, labelUpdate)
	register("label.delete", core.RoleAdmin, labelDelete)
}

type labelCreateArgs struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Project     string `json:"project"` // empty = shared by the whole workspace
}

func labelCreate(c *cx, a labelCreateArgs) error {
	lid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a label needs a name")
	}
	scopeType, scopeID, projectID := "workspace", c.ws, ""
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		scopeType, scopeID, projectID = "project", p.ID, p.ID
	}
	seq := c.tx.NextSeq()
	l := core.Label{ID: lid, WorkspaceID: c.ws, ProjectID: projectID, Name: strings.TrimSpace(a.Name), Color: a.Color,
		Description: a.Description, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, l); err != nil {
		return taken(err, "id", lid)
	}
	return c.created(seq, "label", l.ID, scopeType, scopeID, projectID, l)
}

type labelUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Color       Opt[string] `json:"color"`
	Description Opt[string] `json:"description"`
}

func labelScope(c *cx, l core.Label) (string, string) {
	if l.ProjectID != "" {
		return "project", l.ProjectID
	}
	return "workspace", c.ws
}

func labelUpdate(c *cx, a labelUpdateArgs) error {
	l, err := get[core.Label](c, "label", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &l.Name); err != nil {
		return err
	}
	p.str("color", a.Color, &l.Color)
	p.str("description", a.Description, &l.Description)
	st, sid := labelScope(c, l)
	return c.save(p, "labels", "label", l.ID, st, sid, l.ProjectID, nil)
}

func labelDelete(c *cx, a memberRefArgs) error {
	l, err := get[core.Label](c, "label", "id", a.ID)
	if err != nil {
		return err
	}
	// Tasks drop the label; each says so in its own timeline.
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{LabelIDs: []string{l.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		tp := newPatch()
		if err := c.setLabels(tp, &t, without(t.LabelIDs, l.ID)); err != nil {
			return err
		}
		if err := c.saveOther(t, tp, nil); err != nil {
			return err
		}
	}
	st, sid := labelScope(c, l)
	return c.trash("labels", "label", l.ID, st, sid, l.ProjectID, nil)
}
