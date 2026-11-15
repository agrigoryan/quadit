package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("watch.set", core.RoleMember, watchSet)
}

type watchSetArgs struct {
	Type     string `json:"type"`    // task (default), epic, project, view, doc
	Subject  string `json:"subject"` // its id, or a task key
	Watching *bool  `json:"watching"`
	User     string `json:"user"` // default: the caller
}

func watchSet(c *cx, a watchSetArgs) error {
	if a.Type == "" {
		a.Type = "task"
	}
	userID := c.actor.UserID
	if a.User != "" {
		m, err := c.memberRef("user", a.User)
		if err != nil {
			return err
		}
		userID = m.UserID
	}
	var subjectID, scopeType, projectID string
	scopeType = a.Type
	switch a.Type {
	case "task":
		t, err := c.task("subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID, projectID = t.ID, t.ProjectID
	case "epic":
		e, err := get[core.Epic](c, "epic", "subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID, projectID, scopeType = e.ID, e.ProjectID, "project"
	case "project":
		p, err := c.project(a.Subject)
		if err != nil {
			return err
		}
		subjectID, projectID = p.ID, p.ID
	case "view":
		v, err := get[core.View](c, "view", "subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID, scopeType = v.ID, "workspace"
	case "doc":
		d, err := get[core.Doc](c, "doc", "subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID = d.ID
	default:
		return oneOf("type", "subject type", a.Type, []string{"task", "epic", "project", "view", "doc"})
	}
	scopeID := subjectID
	if scopeType == "project" {
		scopeID = projectID
	} else if scopeType == "workspace" {
		scopeID = c.ws
	}
	w := core.Watcher{WorkspaceID: c.ws, UserID: userID, SubjectType: a.Type, SubjectID: subjectID, CreatedAt: c.at}
	if a.Watching != nil && !*a.Watching {
		n, err := c.tx.Delete(c.ctx, "watchers", store.Eq("subject_id", subjectID), store.Eq("user_id", userID))
		if err != nil || n == 0 {
			return err
		}
		return c.emitTo(userID, c.tx.NextSeq(), "watcher.deleted", "watcher", subjectID, scopeType, scopeID, projectID,
			map[string]any{"id": subjectID, "gone": true, "user_id": userID})
	}
	if n, err := c.tx.Count(c.ctx, "watchers", store.Eq("subject_id", subjectID), store.Eq("user_id", userID)); err != nil || n > 0 {
		return err
	}
	if err := c.tx.Insert(c.ctx, w); err != nil {
		return err
	}
	return c.emitTo(userID, c.tx.NextSeq(), "watcher.created", "watcher", subjectID, scopeType, scopeID, projectID, map[string]any{"row": w})
}
