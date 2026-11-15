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

// taskCreate makes a task. The steps run in this order, and the first thing
// wrong is what the caller is told.
func taskCreate(c *cx, a taskCreateArgs) error {
	tid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	d := &taskDraft{c: c, a: a, id: tid}
	steps := []func() error{
		d.findProject,
		d.template,
		d.basics,
		d.people,
		d.dueAndLabels,
		d.plan,
		d.number,
		d.insert,
		d.openDecision,
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// taskDraft is one task.create under way: what was asked for, where the
// task goes, and its row as far as it is filled in.
type taskDraft struct {
	c       *cx
	a       taskCreateArgs
	id      string
	project core.Project
	parent  core.Task
	st      core.Status
	t       core.Task
	// opens is the decision the task's template opens on it, if any.
	opens *decisionOpenArgs
}

// findProject finds the task's parent and its project: the one named, or else the
// parent's.
func (d *taskDraft) findProject() error {
	c := d.c
	var err error
	if d.a.Parent != "" {
		if d.parent, err = c.task("parent", d.a.Parent); err != nil {
			return err
		}
		if d.a.Project == "" {
			d.a.Project = d.parent.ProjectID
		}
	}
	if d.project, err = c.project(d.a.Project); err != nil {
		return err
	}
	if d.project.ArchivedAt != 0 {
		return conflictErr("project %s is archived", d.project.Key)
	}
	return nil
}

// template fills what the caller left empty from the template named.
func (d *taskDraft) template() error {
	if d.a.Template == "" {
		return nil
	}
	var err error
	d.opens, err = d.c.applyTemplate(d.project, &d.a)
	return err
}

// basics checks what the task says of itself and starts its row.
func (d *taskDraft) basics() error {
	c, a := d.c, d.a
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
	var err error
	if a.Status != "" {
		d.st, err = c.status(d.project, "status", a.Status)
	} else {
		d.st, err = c.defaultStatus(d.project)
	}
	if err != nil {
		return err
	}
	d.t = core.Task{ID: d.id, WorkspaceID: c.ws, ProjectID: d.project.ID, Title: title, Description: a.Description, StatusID: d.st.ID,
		Priority: a.Priority, WaitingOnNote: a.WaitingOnNote, ParentID: d.parent.ID, Estimate: a.Estimate, DueOn: a.DueOn,
		Budget: a.Budget, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	return nil
}

// people sets who the task is given to, who it is worked for, and whose
// move it is.
func (d *taskDraft) people() error {
	c, a, t := d.c, d.a, &d.t
	var err error
	if t.AssigneeID, err = c.optMember("assignee", a.Assignee); err != nil {
		return err
	}
	if t.AskedBy, err = c.askedBy(*t); err != nil {
		return err
	}
	if isOutside(a.WaitingOn) {
		// The next move is not a member's: a build, a reply, a date. The
		// note says what the task waits for.
		if err := checkOutsideNote(a.WaitingOnNote); err != nil {
			return err
		}
		t.WaitingOutside = true
	} else if t.WaitingOnID, err = c.optMember("waiting_on", a.WaitingOn); err != nil {
		return err
	}
	return nil
}

func (d *taskDraft) dueAndLabels() error {
	if err := checkDate("due_on", d.a.DueOn); err != nil {
		return err
	}
	var err error
	d.t.LabelIDs, err = d.c.labelIDs(d.project, "labels", d.a.Labels)
	return err
}

// plan puts the task in its epic, milestone and cycle. A sub-task that
// names no epic is in its parent's, when they share a project.
func (d *taskDraft) plan() error {
	c, a, t := d.c, d.a, &d.t
	var err error
	if a.Epic != "" {
		if t.EpicID, err = c.taskEpic(d.project, a.Epic); err != nil {
			return err
		}
	} else if d.parent.EpicID != "" && d.parent.ProjectID == d.project.ID {
		t.EpicID = d.parent.EpicID
	}
	if a.Milestone != "" {
		ms, err := c.taskMilestone(a.Milestone, t.EpicID)
		if err != nil {
			return err
		}
		t.MilestoneID, t.EpicID = ms.ID, ms.EpicID
	}
	t.CycleID, err = c.taskCycle(d.project, a.Cycle)
	return err
}

// number gives the task its number, the next one or the one asked for, and
// with it its key and its place in the order.
func (d *taskDraft) number() error {
	t := &d.t
	pick := d.nextNumber
	if d.a.Number != 0 {
		pick = d.givenNumber
	}
	n, err := pick()
	if err != nil {
		return err
	}
	t.Number = int(n)
	t.Key = d.project.Key + "-" + itoa(t.Number)
	t.Rank = d.a.Rank
	if t.Rank == "" {
		t.Rank = rank.ForNumber(t.Number)
	} else if !rank.Valid(t.Rank) {
		return invalid("rank", "%q is not a rank", t.Rank)
	}
	return nil
}

// givenNumber checks a number asked for (by an import) is free, and moves
// the project's count past it.
func (d *taskDraft) givenNumber() (int64, error) {
	c, number, project := d.c, d.a.Number, d.project
	if number < 0 {
		return 0, invalid("number", "a task's number is 1 or more")
	}
	if !c.system && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return 0, forbidden("choosing a task's number is for imports and needs the admin role; leave number out and the task gets the next one")
	}
	key := project.Key + "-" + itoa(number)
	taken, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", project.ID), store.Eq("number", number))
	if err != nil {
		return 0, err
	}
	was, err := c.tx.Count(c.ctx, "task_keys", store.Eq("key", key))
	if err != nil {
		return 0, err
	}
	if taken+was > 0 {
		return 0, conflictErr("%s is taken; leave number out and the task gets the next one", key)
	}
	// The project's own count moves past it, so the next task made the
	// usual way does not land on it.
	if over := number - project.TaskCounter; over > 0 {
		if _, err := c.tx.Incr(c.ctx, "projects", "task_counter", int64(over), store.Eq("id", project.ID)); err != nil {
			return 0, err
		}
	}
	return int64(number), nil
}

// nextNumber is the project's next task number, past any a task was given
// by hand.
func (d *taskDraft) nextNumber() (int64, error) {
	c, project := d.c, d.project
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
			return n, nil
		}
	}
}

// insert writes the task and says so: in the feed, to search, and to the
// people it names.
func (d *taskDraft) insert() error {
	c, t := d.c, &d.t
	stampStatus(&t.StartedAt, &t.CompletedAt, &t.CanceledAt, d.st.Category, c.at)
	seq := c.tx.NextSeq()
	t.CreatedSeq, t.UpdatedSeq, t.ActivitySeq = seq, seq, seq
	if err := c.tx.Insert(c.ctx, *t); err != nil {
		return alreadyInUse(err, "id", t.ID)
	}
	for _, l := range t.LabelIDs {
		if err := c.tx.Insert(c.ctx, core.TaskLabel{TaskID: t.ID, LabelID: l, WorkspaceID: c.ws}); err != nil {
			return err
		}
	}
	if err := c.created(seq, "task", t.ID, place{scopeType: "task", scopeID: t.ID, projectID: d.project.ID}, *t); err != nil {
		return err
	}
	c.key = t.Key
	if err := c.afterTaskPeople(*t, t.AssigneeID, t.WaitingOnID); err != nil {
		return err
	}
	return c.afterTaskText(*t)
}

// openDecision opens the decision the template asks for on the new task.
func (d *taskDraft) openDecision() error {
	if d.opens == nil {
		return nil
	}
	o := *d.opens
	o.ID, o.Task = "", d.t.ID
	return d.c.applyNested("decision.open", o)
}

func taskDelete(c *cx, a idArgs) error {
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("deleted_at", int64(0), c.at)
	p.set["deleted_by"] = c.actor.UserID
	if err := c.saveTask(t, p, map[string]any{"deleted": true}); err != nil {
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
	if err := c.saveTask(t, p, map[string]any{"restored": true}); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "task", EntityID: t.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: t.Key + " " + t.Title, Body: t.Description})
}
