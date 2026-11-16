// label.create, label.update and label.delete.

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
	Name        string `json:"name" quadit:"required,handler"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Project     string `json:"project"` // empty = shared by the whole workspace
}

// labelCreate adds a label to a project, or to the whole workspace.
func labelCreate(c *cx, a labelCreateArgs) error {
	lid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a label needs a name")
	}
	projectID := ""
	if a.Project != "" {
		project, err := c.project(a.Project)
		if err != nil {
			return err
		}
		projectID = project.ID
	}
	seq := c.tx.NextSeq()
	l := core.Label{ID: lid, WorkspaceID: c.ws, ProjectID: projectID, Name: strings.TrimSpace(a.Name), Color: a.Color,
		Description: a.Description, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, l); err != nil {
		return alreadyInUse(err, "id", lid)
	}
	return c.created(seq, "label", l.ID, c.inProjectOrWorkspace(projectID), l)
}

type labelUpdateArgs struct {
	ID          string      `json:"id" quadit:"required"`
	Name        Opt[string] `json:"name"`
	Color       Opt[string] `json:"color"`
	Description Opt[string] `json:"description"`
}

func labelUpdate(c *cx, a labelUpdateArgs) error {
	l, err := loadLive[core.Label](c, "label", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &l.Name); err != nil {
		return err
	}
	p.setText("color", a.Color, &l.Color)
	p.setText("description", a.Description, &l.Description)
	return c.save(p, target{table: "labels", entity: "label", id: l.ID, place: c.inProjectOrWorkspace(l.ProjectID)})
}

// labelDelete puts a label in the trash and takes it off its tasks.
func labelDelete(c *cx, a memberRefArgs) error {
	l, err := loadLive[core.Label](c, "label", "id", a.ID)
	if err != nil {
		return err
	}
	// Tasks drop the label; each says so in its own timeline.
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{LabelIDs: []string{l.ID}, Archived: true, Limit: scanLimit})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		tp := newPatch()
		if err := c.setLabels(tp, &t, without(t.LabelIDs, l.ID)); err != nil {
			return err
		}
		if err := c.saveOther(t, tp, core.EventData{}); err != nil {
			return err
		}
	}
	return c.trash(target{table: "labels", entity: "label", id: l.ID, place: c.inProjectOrWorkspace(l.ProjectID)})
}

// without is a list of label ids without one of them.
func without(list []string, v string) []string {
	out := make([]string, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}
