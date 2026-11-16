// task.create, task.delete and task.restore.

package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("task.create", core.RoleMember, taskCreate)
	register("task.delete", core.RoleMember, taskDelete)
	register("task.restore", core.RoleMember, taskRestore)
}

type taskCreateArgs struct {
	ID            string       `json:"id"`
	Project       string       `json:"project"`
	Title         string       `json:"title"`
	Description   string       `json:"description"`
	Status        string       `json:"status"`
	Priority      int          `json:"priority"`
	Assignee      string       `json:"assignee"`
	WaitingOn     string       `json:"waiting_on"`
	WaitingOnNote string       `json:"waiting_on_note"`
	Parent        string       `json:"parent"`
	Epic          string       `json:"epic"`
	Milestone     string       `json:"milestone"`
	Cycle         string       `json:"cycle"`
	Estimate      int          `json:"estimate"`
	Labels        []string     `json:"labels"`
	DueOn         string       `json:"due_on"`
	Rank          string       `json:"rank"`
	Template      string       `json:"template"`
	Budget        *core.Budget `json:"budget"`
	// Number gives the task this number instead of the next one, so an
	// import keeps SVA-12 as SVA-12. For admins; the number must be free.
	Number int `json:"number"`
}

// taskCreate makes a task. The checks run in this order, and the first thing
// wrong is what the caller is told.
func taskCreate(c *cx, a taskCreateArgs) error {
	tid, err := newID("id", a.ID)
	if err != nil {
		return err
	}

	// The parent, when it has one, and the project: the one named, or else
	// the parent's.
	var parent core.Task
	if a.Parent != "" {
		if parent, err = c.task("parent", a.Parent); err != nil {
			return err
		}
		if a.Project == "" {
			a.Project = parent.ProjectID
		}
	}
	project, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if project.ArchivedAt != 0 {
		return conflictErr("project %s is archived", project.Key)
	}

	// The template fills what the caller left empty, and may open a
	// decision on the task once it is made.
	var opens *decisionOpenArgs
	if a.Template != "" {
		if opens, err = c.applyTemplate(project, &a); err != nil {
			return err
		}
	}

	// What the task says of itself.
	title := strings.TrimSpace(a.Title)
	if title == "" {
		return invalid("title", "a task needs a title")
	}
	if !priorityOK(a.Priority) {
		return invalid("priority", priorityHelp)
	}
	if err := checkEstimate(a.Estimate); err != nil {
		return err
	}
	var st core.Status
	if a.Status != "" {
		st, err = c.status(project, "status", a.Status)
	} else {
		st, err = c.defaultStatus(project)
	}
	if err != nil {
		return err
	}
	t := core.Task{ID: tid, WorkspaceID: c.ws, ProjectID: project.ID, Title: title, Description: a.Description, StatusID: st.ID,
		Priority: a.Priority, WaitingOnNote: a.WaitingOnNote, ParentID: parent.ID, Estimate: a.Estimate, DueOn: a.DueOn,
		Budget: a.Budget, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}

	// Who it is given to, who it is worked for, and whose move it is.
	if t.AssigneeID, err = c.personOnTask("assignee", a.Assignee, t); err != nil {
		return err
	}
	if t.AskedBy, err = c.askedBy(t); err != nil {
		return err
	}
	if isOutside(a.WaitingOn) {
		// The next move is not a member's: a build, a reply, a date. The
		// note says what the task waits for.
		if err := checkOutsideNote(a.WaitingOnNote); err != nil {
			return err
		}
		t.WaitingOutside = true
	} else if t.WaitingOnID, err = c.personOnTask("waiting_on", a.WaitingOn, t); err != nil {
		return err
	}

	if err := checkDate("due_on", a.DueOn); err != nil {
		return err
	}
	if t.LabelIDs, err = c.labelIDs(project, "labels", a.Labels); err != nil {
		return err
	}

	// Its epic, milestone and cycle. A sub-task that names no epic is in its
	// parent's, when they share a project.
	if a.Epic != "" {
		if t.EpicID, err = c.taskEpic(project, a.Epic); err != nil {
			return err
		}
	} else if parent.EpicID != "" && parent.ProjectID == project.ID {
		t.EpicID = parent.EpicID
	}
	if a.Milestone != "" {
		ms, err := c.taskMilestone(a.Milestone, t.EpicID)
		if err != nil {
			return err
		}
		t.MilestoneID, t.EpicID = ms.ID, ms.EpicID
	}
	if t.CycleID, err = c.taskCycle(project, a.Cycle); err != nil {
		return err
	}

	// Its number, and with it its key and its place in the order.
	if t.Number, err = c.newTaskNumber(project, a.Number); err != nil {
		return err
	}
	t.Key = project.Key + "-" + itoa(t.Number)
	t.Rank = a.Rank
	if t.Rank == "" {
		t.Rank = rank.ForNumber(t.Number)
	} else if !rank.Valid(t.Rank) {
		return invalid("rank", "%q is not a rank", t.Rank)
	}

	// Write it and say so: in the feed, to search, and to the people it
	// names.
	stampStatus(&t.StartedAt, &t.CompletedAt, &t.CanceledAt, st.Category, c.at)
	seq := c.tx.NextSeq()
	t.CreatedSeq, t.UpdatedSeq, t.ActivitySeq = seq, seq, seq
	if err := c.tx.Insert(c.ctx, t); err != nil {
		return alreadyInUse(err, "id", t.ID)
	}
	for _, l := range t.LabelIDs {
		if err := c.tx.Insert(c.ctx, core.TaskLabel{TaskID: t.ID, LabelID: l, WorkspaceID: c.ws}); err != nil {
			return err
		}
	}
	if err := c.created(seq, "task", t.ID, place{scopeType: "task", scopeID: t.ID, projectID: project.ID}, t); err != nil {
		return err
	}
	c.key = t.Key
	if err := c.afterTaskPeople(t, t.AssigneeID, t.WaitingOnID); err != nil {
		return err
	}
	if err := c.afterTaskText(t); err != nil {
		return err
	}

	// The decision the template opens on it.
	if opens == nil {
		return nil
	}
	o := *opens
	o.ID, o.Task = "", t.ID
	return c.applyNested("decision.open", o)
}

// newTaskNumber is the number a new task in the project gets: asked, when
// it is not 0, or else the project's next one. A number asked for (by an
// import) must be free, and the project's count moves past it; the next
// one skips any a task was given that way.
func (c *cx) newTaskNumber(project core.Project, asked int) (int, error) {
	if asked != 0 {
		if asked < 0 {
			return 0, invalid("number", "a task's number is 1 or more")
		}
		if !c.system && !c.actor.Role.AtLeast(core.RoleAdmin) {
			return 0, forbidden("choosing a task's number is for imports and needs the admin role; leave number out and the task gets the next one")
		}
		key := project.Key + "-" + itoa(asked)
		taken, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", project.ID), store.Eq("number", asked))
		if err != nil {
			return 0, err
		}
		was, err := c.tx.Count(c.ctx, "task_keys", store.Eq("key", key))
		if err != nil {
			return 0, err
		}
		if taken+was > 0 {
			e := conflictErr("%s is taken; leave number out and the task gets the next one", key)
			e.Reason = ReasonNumberTaken
			return 0, e
		}
		// The project's own count moves past it, so the next task made the
		// usual way does not land on it.
		if over := asked - project.TaskCounter; over > 0 {
			if _, err := c.tx.Incr(c.ctx, "projects", "task_counter", int64(over), store.Eq("id", project.ID)); err != nil {
				return 0, err
			}
		}
		return asked, nil
	}
	for {
		n, err := c.tx.Incr(c.ctx, "projects", "task_counter", 1, store.Eq("id", project.ID))
		if err != nil {
			return 0, err
		}
		taken, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", project.ID), store.Eq("number", int(n)))
		if err != nil {
			return 0, err
		}
		if taken == 0 {
			return int(n), nil
		}
	}
}

func taskDelete(c *cx, a idArgs) error {
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("deleted_at", int64(0), c.at)
	p.set["deleted_by"] = c.actor.UserID
	if err := c.saveTask(t, p, core.EventData{Deleted: true}); err != nil {
		return err
	}
	if err := c.endDelegates(t); err != nil {
		return err
	}
	return c.tx.Unindex(c.ctx, t.ID)
}

func taskRestore(c *cx, a idArgs) error {
	t, err := c.anyTask("id", a.ID)
	if err != nil {
		return err
	}
	if t.DeletedAt == 0 {
		c.ref, c.key = t.ID, t.Key
		return nil // not in the trash: nothing to do
	}
	p := newPatch()
	p.put("deleted_at", t.DeletedAt, int64(0))
	p.set["deleted_by"] = ""
	if err := c.saveTask(t, p, core.EventData{Restored: true}); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "task", EntityID: t.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: t.Key + " " + t.Title, Body: t.Description})
}
