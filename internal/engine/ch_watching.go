// watch.set: following a task, epic, project, view or page.

package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("watch.set", core.RoleMember, watchSet)
}

type watchSetArgs struct {
	Type     string `json:"type"`                              // task (default), epic, project, view, doc
	Subject  string `json:"subject" quadit:"required,handler"` // its id, or a task key
	Watching *bool  `json:"watching"`
	User     string `json:"user"` // default: the caller
}

// watchSet makes a member follow a task, epic, project, view or page, or
// stop. A member follows only what they may see; stopping is always
// allowed.
func watchSet(c *cx, a watchSetArgs) error {
	if a.Type == "" {
		a.Type = "task"
	}
	watcher := c.actor
	if a.User != "" {
		m, err := c.memberRef("user", a.User)
		if err != nil {
			return err
		}
		watcher = m
	}
	userID := watcher.UserID
	subjectID, where, mayFollow, err := c.watchSubject(a.Type, a.Subject, watcher)
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
	if !mayFollow {
		if userID != c.actor.UserID {
			return invalid("user", "@%s may not see this %s, so they cannot follow it", watcher.Handle, a.Type)
		}
		return forbidden("you may not see this %s, so you cannot follow it", a.Type)
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

// watchSubject finds what is to be watched; where the watcher's events
// belong, which is in the project of what is watched, so that they reach
// only those who may read it; and whether the watcher may see it, by the
// rule the reads keep: a task, an epic or a project of a project they may
// read, a view that is shared or theirs, a page they may see.
func (c *cx) watchSubject(subjectType, ref string, watcher core.Member) (string, place, bool, error) {
	switch subjectType {
	case "task":
		t, err := c.task("subject", ref)
		return t.ID, inTask(t), watcher.Scope.MayRead(t.ProjectID), err
	case "epic":
		e, err := loadLive[core.Epic](c, "epic", "subject", ref)
		return e.ID, inProject(e.ProjectID), watcher.Scope.MayRead(e.ProjectID), err
	case "project":
		project, err := c.project(ref)
		return project.ID, inProject(project.ID), watcher.Scope.MayRead(project.ID), err
	case "view":
		v, err := loadLive[core.View](c, "view", "subject", ref)
		mayFollow := (v.Shared || v.OwnerID == watcher.UserID) && watcher.Scope.MayRead(v.ProjectID)
		return v.ID, c.inProjectOrWorkspace(v.ProjectID), mayFollow, err
	case "doc":
		d, err := loadLive[core.Doc](c, "doc", "subject", ref)
		return d.ID, inDoc(d), CanSeeDoc(d, watcher.UserID) && watcher.Scope.MayRead(d.ProjectID), err
	}
	return "", place{}, false, oneOf("type", "subject type", subjectType, []string{"task", "epic", "project", "view", "doc"})
}
