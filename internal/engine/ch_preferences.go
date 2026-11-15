package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

func init() {
	register("preference.create", core.RoleAdmin, preferenceCreate)
	register("preference.update", core.RoleAdmin, preferenceUpdate)
	register("preference.delete", core.RoleAdmin, preferenceDelete)
}

type preferenceCreateArgs struct {
	ID       string   `json:"id"`
	Body     string   `json:"body"`
	Project  string   `json:"project"`  // empty = the whole workspace
	Decision string   `json:"decision"` // the decision it came from
	Labels   []string `json:"labels"`   // shown on tasks with any of these labels; empty = all tasks
}

func preferenceCreate(c *cx, a preferenceCreateArgs) error {
	pid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Body) == "" {
		return invalid("body", "a preference needs its rule in words")
	}
	pf := core.Preference{ID: pid, WorkspaceID: c.ws, Body: strings.TrimSpace(a.Body), CreatedBy: c.actor.UserID, CreatedAt: c.at}
	var pr core.Project
	if a.Decision != "" {
		d, t, err := c.decisionTask(a.Decision)
		if err != nil {
			return err
		}
		pf.DecisionID = d.ID
		if a.Project == "" {
			a.Project = t.ProjectID
		}
	}
	if a.Project != "" {
		if pr, err = c.project(a.Project); err != nil {
			return err
		}
		pf.ProjectID = pr.ID
		if pf.LabelIDs, err = c.labelIDs(pr, "labels", a.Labels); err != nil {
			return err
		}
	} else if len(a.Labels) > 0 {
		return invalid("labels", "labels need a project")
	}
	seq := c.tx.NextSeq()
	pf.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, pf); err != nil {
		return alreadyInUse(err, "id", pid)
	}
	return c.created(seq, "preference", pf.ID, c.inProjectOrWorkspace(pf.ProjectID), pf)
}

type preferenceUpdateArgs struct {
	ID      string      `json:"id"`
	Body    Opt[string] `json:"body"`
	Retired Opt[bool]   `json:"retired"`
}

func preferenceUpdate(c *cx, a preferenceUpdateArgs) error {
	pf, err := loadLive[core.Preference](c, "preference", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("body", a.Body, &pf.Body); err != nil {
		return err
	}
	if a.Retired.Set {
		if a.Retired.V && pf.RetiredAt == 0 {
			p.put("retired_at", int64(0), c.at)
		} else if !a.Retired.V && pf.RetiredAt != 0 {
			p.put("retired_at", pf.RetiredAt, int64(0))
		}
	}
	return c.save(p, target{table: "preferences", entity: "preference", id: pf.ID, place: c.inProjectOrWorkspace(pf.ProjectID)})
}

func preferenceDelete(c *cx, a idArgs) error {
	pf, err := loadLive[core.Preference](c, "preference", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash(target{table: "preferences", entity: "preference", id: pf.ID, place: c.inProjectOrWorkspace(pf.ProjectID)})
}
