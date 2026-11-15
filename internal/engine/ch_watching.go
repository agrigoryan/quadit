// watch.set: following a task, epic, project, view or page.

package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers watch.set.
func init() {
	register("watch.set", core.RoleMember, watchSet)
}

type watchSetArgs struct {
	Type     string `json:"type"`    // task (default), epic, project, view, doc
	Subject  string `json:"subject"` // its id, or a task key
	Watching *bool  `json:"watching"`
	User     string `json:"user"` // default: the caller
}

// watchSet makes a member follow a task, epic, project, view or page, or
// stop.
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
	subjectID, where, err := c.watchSubject(a.Type, a.Subject)
	if err != nil {
		return err
	}
	if a.Watching != nil && !*a.Watching {
		n, err := c.tx.Delete(c.ctx, "watchers", store.Eq("subject_id", subjectID), store.Eq("user_id", userID))
		if err != nil || n == 0 {
			return err
		}
		return c.emit(event{seq: c.tx.NextSeq(), typ: "watcher.deleted", entity: "watcher", entityID: subjectID, place: where, audience: userID,
			data: core.EventData{ID: subjectID, Gone: true, UserID: userID}})
	}
	if n, err := c.tx.Count(c.ctx, "watchers", store.Eq("subject_id", subjectID), store.Eq("user_id", userID)); err != nil || n > 0 {
		return err
	}
	w := core.Watcher{WorkspaceID: c.ws, UserID: userID, SubjectType: a.Type, SubjectID: subjectID, CreatedAt: c.at}
	if err := c.tx.Insert(c.ctx, w); err != nil {
		return err
	}
	return c.emit(event{seq: c.tx.NextSeq(), typ: "watcher.created", entity: "watcher", entityID: subjectID, place: where, audience: userID, data: core.EventData{Row: w}})
}

// watchSubject finds what is to be watched, and where the watcher's events
// belong: an epic's in its project, a view's in the workspace.
func (c *cx) watchSubject(subjectType, ref string) (string, place, error) {
	switch subjectType {
	case "task":
		t, err := c.task("subject", ref)
		return t.ID, inTask(t), err
	case "epic":
		e, err := loadLive[core.Epic](c, "epic", "subject", ref)
		return e.ID, inProject(e.ProjectID), err
	case "project":
		project, err := c.project(ref)
		return project.ID, inProject(project.ID), err
	case "view":
		v, err := loadLive[core.View](c, "view", "subject", ref)
		return v.ID, inWorkspace(c.ws), err
	case "doc":
		d, err := loadLive[core.Doc](c, "doc", "subject", ref)
		return d.ID, place{scopeType: "doc", scopeID: d.ID}, err
	}
	return "", place{}, oneOf("type", "subject type", subjectType, []string{"task", "epic", "project", "view", "doc"})
}
