package engine

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("agent.create", core.RoleAdmin, agentCreate)
	register("member.add", core.RoleAdmin, memberAdd)
	register("project.create", core.RoleAdmin, projectCreate)
	register("label.create", core.RoleMember, labelCreate)
	register("task.create", core.RoleMember, taskCreate)
	register("task.update", core.RoleMember, taskUpdate)
	register("task.delete", core.RoleMember, taskDelete)
	register("task.restore", core.RoleMember, taskRestore)
	register("comment.create", core.RoleMember, commentCreate)
	register("decision.open", core.RoleMember, decisionOpen)
	register("decision.pick", core.RoleMember, decisionPick)
}

// ---- members and agents ----

type agentCreateArgs struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Handle        string `json:"handle"`
	Role          string `json:"role"`           // member (default) or admin
	ResponsibleID string `json:"responsible_id"` // the person who answers for it; default: the caller
}

func agentCreate(c *cx) error {
	var a agentCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	uid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "an agent needs a name")
	}
	if err := checkHandle(a.Handle); err != nil {
		return err
	}
	role := core.Role(a.Role)
	if a.Role == "" {
		role = core.RoleMember
	}
	if role != core.RoleMember && role != core.RoleAdmin {
		return &Error{Code: CodeInvalid, Field: "role", Message: "an agent can be a member or an admin; the owner role is for people",
			Allowed: []string{string(core.RoleMember), string(core.RoleAdmin)}}
	}
	// An agent never gets more access than the member who creates it.
	if !c.actor.Role.AtLeast(role) {
		return forbidden("you are a %s and cannot create an agent with the %s role", c.actor.Role, role)
	}
	// Someone answers for every agent. By default that is the person who
	// creates it; an agent that creates another passes on its own.
	responsible := a.ResponsibleID
	if responsible == "" {
		responsible = c.actor.UserID
		if c.actor.Kind == core.KindAgent {
			self, err := c.user(c.actor.UserID)
			if err != nil {
				return err
			}
			responsible = self.ResponsibleID
		}
	}
	rm, err := c.tx.Member(c.ctx, c.ws, responsible)
	if err != nil {
		return missing(err, "member", responsible)
	}
	if rm.Kind != core.KindPerson {
		return invalid("responsible_id", "the one responsible for an agent must be a person, not another agent")
	}
	u := core.User{ID: uid, Kind: core.KindAgent, Name: strings.TrimSpace(a.Name), WorkspaceID: c.ws,
		ResponsibleID: responsible, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if err := c.tx.InsertUser(c.ctx, u); err != nil {
		return taken(err, "id", uid)
	}
	return c.addMember(core.Member{WorkspaceID: c.ws, UserID: uid, Role: role, Handle: a.Handle, Kind: u.Kind, Name: u.Name, CreatedAt: c.at})
}

type memberAddArgs struct {
	UserID string `json:"user_id"`
	Handle string `json:"handle"`
	Role   string `json:"role"`
}

func memberAdd(c *cx) error {
	var a memberAddArgs
	if err := c.args(&a); err != nil {
		return err
	}
	if err := checkHandle(a.Handle); err != nil {
		return err
	}
	role := core.Role(a.Role)
	if a.Role == "" {
		role = core.RoleMember
	}
	if !role.AtLeast(core.RoleMember) {
		return &Error{Code: CodeInvalid, Field: "role", Message: "unknown role " + a.Role,
			Allowed: []string{string(core.RoleMember), string(core.RoleAdmin), string(core.RoleOwner)}}
	}
	if !c.actor.Role.AtLeast(role) {
		return forbidden("you are a %s and cannot add a member with the %s role", c.actor.Role, role)
	}
	u, err := c.user(a.UserID)
	if err != nil {
		return err
	}
	if u.Kind != core.KindPerson {
		return invalid("user_id", "agents are created in their workspace with agent.create, not added")
	}
	return c.addMember(core.Member{WorkspaceID: c.ws, UserID: u.ID, Role: role, Handle: a.Handle, Kind: u.Kind, Name: u.Name, CreatedAt: c.at})
}

func (c *cx) addMember(m core.Member) error {
	seq := c.tx.NextSeq()
	if err := c.tx.InsertMember(c.ctx, m, seq); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return conflictErr("the handle @%s is taken, or this user is already a member", m.Handle)
		}
		return err
	}
	return c.emit(seq, "member.added", "member", m.UserID, "workspace", c.ws, "", map[string]any{"member": m})
}

// user loads any user by id. Users live outside workspaces.
func (c *cx) user(userID string) (core.User, error) {
	if userID == "" {
		return core.User{}, invalid("user_id", "user_id is required")
	}
	u, err := c.tx.User(c.ctx, userID)
	return u, missing(err, "user", userID)
}

// member checks that userID is a member of the workspace.
func (c *cx) member(field, userID string) (core.Member, error) {
	m, err := c.tx.Member(c.ctx, c.ws, userID)
	if errors.Is(err, store.ErrNotFound) {
		return m, &Error{Code: CodeNotFound, Field: field, Message: "no member with id " + userID + " in this workspace"}
	}
	return m, err
}

func taken(err error, what, value string) error {
	if errors.Is(err, store.ErrConflict) {
		return conflictErr("%s %q is already in use", what, value)
	}
	return err
}

// ---- projects, statuses, labels ----

var projectKeyRE = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

type projectCreateArgs struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// defaultStatuses is what a new project starts with. "Waiting" is its own
// category so "who has the next move" is visible on every board.
var defaultStatuses = []struct{ name, category, color string }{
	{"Backlog", core.CatBacklog, "#9ca3af"},
	{"Todo", core.CatUnstarted, "#6b7280"},
	{"In Progress", core.CatStarted, "#f59e0b"},
	{"Waiting", core.CatWaiting, "#8b5cf6"},
	{"Done", core.CatDone, "#10b981"},
	{"Canceled", core.CatCanceled, "#ef4444"},
}

func projectCreate(c *cx) error {
	var a projectCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if !projectKeyRE.MatchString(a.Key) {
		return invalid("key", "a project key is 2 to 10 upper-case letters or digits, starting with a letter (it prefixes task numbers: SVA-12)")
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a project needs a name")
	}
	p := core.Project{ID: pid, WorkspaceID: c.ws, Key: a.Key, Name: strings.TrimSpace(a.Name), Description: a.Description,
		CreatedBy: c.actor.UserID, CreatedAt: c.at}
	seq := c.tx.NextSeq()
	p.UpdatedSeq = seq
	if err := c.tx.InsertProject(c.ctx, p, seq); err != nil {
		return taken(err, "project key", a.Key)
	}
	if err := c.emit(seq, "project.created", "project", p.ID, "project", p.ID, p.ID, map[string]any{"project": p}); err != nil {
		return err
	}
	for i, d := range defaultStatuses {
		st := core.Status{ID: mustID(), ProjectID: p.ID, Name: d.name, Color: d.color, Category: d.category,
			Rank: rank.ForNumber(i + 1), IsDefault: d.category == core.CatUnstarted}
		seq := c.tx.NextSeq()
		if err := c.tx.InsertStatus(c.ctx, c.ws, st, seq); err != nil {
			return err
		}
		if err := c.emit(seq, "status.created", "status", st.ID, "project", p.ID, p.ID, map[string]any{"status": st}); err != nil {
			return err
		}
	}
	return nil
}

func mustID() string {
	s, _ := newID("", "")
	return s
}

type labelCreateArgs struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	ProjectID string `json:"project_id"` // empty = shared by the whole workspace
}

func labelCreate(c *cx) error {
	var a labelCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	lid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a label needs a name")
	}
	scopeType, scopeID := "workspace", c.ws
	if a.ProjectID != "" {
		if _, err := c.tx.Project(c.ctx, c.ws, a.ProjectID); err != nil {
			return missing(err, "project", a.ProjectID)
		}
		scopeType, scopeID = "project", a.ProjectID
	}
	l := core.Label{ID: lid, ProjectID: a.ProjectID, Name: strings.TrimSpace(a.Name), Color: a.Color}
	seq := c.tx.NextSeq()
	if err := c.tx.InsertLabel(c.ctx, c.ws, l, seq); err != nil {
		return taken(err, "id", lid)
	}
	return c.emit(seq, "label.created", "label", l.ID, scopeType, scopeID, a.ProjectID, map[string]any{"label": l})
}

// ---- tasks ----

type taskCreateArgs struct {
	ID            string   `json:"id"`
	ProjectID     string   `json:"project_id"`
	Project       string   `json:"project"` // a project key, instead of project_id
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	StatusID      string   `json:"status_id"`
	Priority      int      `json:"priority"`
	AssigneeID    string   `json:"assignee_id"`
	WaitingOnID   string   `json:"waiting_on_id"`
	WaitingOnNote string   `json:"waiting_on_note"`
	ParentID      string   `json:"parent_id"`
	DueOn         string   `json:"due_on"`
	LabelIDs      []string `json:"label_ids"`
}

func taskCreate(c *cx) error {
	var a taskCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	tid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	var p core.Project
	switch {
	case a.ProjectID != "":
		p, err = c.tx.Project(c.ctx, c.ws, a.ProjectID)
		err = missing(err, "project", a.ProjectID)
	case a.Project != "":
		p, err = c.tx.ProjectByKey(c.ctx, c.ws, strings.ToUpper(a.Project))
		err = missing(err, "project", a.Project)
	default:
		err = invalid("project", "a task needs a project: give project (its key) or project_id")
	}
	if err != nil {
		return err
	}
	title := strings.TrimSpace(a.Title)
	if title == "" {
		return invalid("title", "a task needs a title")
	}
	if a.Priority < 0 || a.Priority > 4 {
		return invalid("priority", "priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)")
	}

	var st core.Status
	if a.StatusID != "" {
		if st, err = c.statusIn(p, a.StatusID); err != nil {
			return err
		}
	} else if st, err = c.tx.DefaultStatus(c.ctx, c.ws, p.ID); err != nil {
		return missing(err, "default status of project", p.Key)
	}
	if a.AssigneeID != "" {
		if _, err := c.member("assignee_id", a.AssigneeID); err != nil {
			return err
		}
	}
	if a.WaitingOnID != "" {
		if _, err := c.member("waiting_on_id", a.WaitingOnID); err != nil {
			return err
		}
	}
	if a.ParentID != "" {
		if _, err := c.tx.Task(c.ctx, c.ws, a.ParentID); err != nil {
			return missing(err, "parent task", a.ParentID)
		}
	}
	if err := checkDate("due_on", a.DueOn); err != nil {
		return err
	}
	for _, l := range a.LabelIDs {
		if err := c.labelFor(p, l); err != nil {
			return err
		}
	}

	number, err := c.tx.NextTaskNumber(c.ctx, p.ID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	t := core.Task{
		ID: tid, WorkspaceID: c.ws, ProjectID: p.ID, Number: number, Key: taskKey(p.Key, number),
		Title: title, Description: a.Description, StatusID: st.ID, Priority: a.Priority,
		AssigneeID: a.AssigneeID, WaitingOnID: a.WaitingOnID, WaitingOnNote: a.WaitingOnNote, ParentID: a.ParentID,
		Rank: rank.ForNumber(number), DueOn: a.DueOn, LabelIDs: a.LabelIDs,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at,
		CreatedSeq: seq, UpdatedSeq: seq, ActivitySeq: seq,
	}
	stampStatus(&t.StartedAt, &t.CompletedAt, &t.CanceledAt, st.Category, c.at)
	if err := c.tx.InsertTask(c.ctx, t); err != nil {
		return taken(err, "id", tid)
	}
	return c.emit(seq, "task.created", "task", t.ID, "task", t.ID, p.ID, map[string]any{"task": t})
}

func taskKey(projectKey string, number int) string {
	return projectKey + "-" + itoa(number)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// stampStatus keeps the lifecycle times in step with the status category.
func stampStatus(started, completed, canceled *int64, category string, at int64) {
	switch category {
	case core.CatStarted, core.CatWaiting:
		if *started == 0 {
			*started = at
		}
		*completed, *canceled = 0, 0
	case core.CatDone:
		if *started == 0 {
			*started = at
		}
		if *completed == 0 {
			*completed = at
		}
		*canceled = 0
	case core.CatCanceled:
		if *canceled == 0 {
			*canceled = at
		}
		*completed = 0
	default: // backlog, unstarted: reopened
		*completed, *canceled = 0, 0
	}
}

// statusIn checks that a status belongs to the task's project and, if not,
// tells the caller which ones do.
func (c *cx) statusIn(p core.Project, statusID string) (core.Status, error) {
	st, err := c.tx.Status(c.ctx, c.ws, statusID)
	if err == nil && st.ProjectID == p.ID {
		return st, nil
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return st, err
	}
	return st, &Error{Code: CodeInvalid, Field: "status_id", Message: "status " + statusID + " is not a status of project " + p.Key}
}

func (c *cx) labelFor(p core.Project, labelID string) error {
	l, err := c.tx.Label(c.ctx, c.ws, labelID)
	if err != nil {
		return missing(err, "label", labelID)
	}
	if l.ProjectID != "" && l.ProjectID != p.ID {
		return invalid("label_ids", "label %q belongs to another project", l.Name)
	}
	return nil
}

func checkDate(field, s string) error {
	if s == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return invalid(field, "%q is not a date: use YYYY-MM-DD", s)
	}
	return nil
}

type taskUpdateArgs struct {
	ID string `json:"id"`
	// BaseSeq, when given, is the task's updated_seq the caller last saw. If
	// the task has changed since, the update is refused instead of applied
	// over the newer values.
	BaseSeq        int64       `json:"base_seq"`
	Title          Opt[string] `json:"title"`
	Description    Opt[string] `json:"description"`
	StatusID       Opt[string] `json:"status_id"`
	Priority       Opt[int]    `json:"priority"`
	AssigneeID     Opt[string] `json:"assignee_id"`
	WaitingOnID    Opt[string] `json:"waiting_on_id"`
	WaitingOnNote  Opt[string] `json:"waiting_on_note"`
	ParentID       Opt[string] `json:"parent_id"`
	DueOn          Opt[string] `json:"due_on"`
	Rank           Opt[string] `json:"rank"`
	AddLabelIDs    []string    `json:"add_label_ids"`
	RemoveLabelIDs []string    `json:"remove_label_ids"`
}

// liveTask loads a task that is not in the trash.
func (c *cx) liveTask(taskID string) (core.Task, error) {
	if taskID == "" {
		return core.Task{}, invalid("id", "the task id is required")
	}
	t, err := c.tx.Task(c.ctx, c.ws, taskID)
	if err != nil {
		return t, missing(err, "task", taskID)
	}
	if t.DeletedAt != 0 {
		return t, conflictErr("task %s is in the trash; restore it first", t.Key)
	}
	return t, nil
}

func taskUpdate(c *cx) error {
	var a taskUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.liveTask(a.ID)
	if err != nil {
		return err
	}
	if a.BaseSeq > 0 && t.UpdatedSeq > a.BaseSeq {
		return &Error{Code: CodeStale, Message: "task " + t.Key + " changed since seq " + itoa(int(a.BaseSeq)) +
			" (it is now at " + itoa(int(t.UpdatedSeq)) + "); read it again, or resend without base_seq to overwrite"}
	}
	p, err := c.tx.Project(c.ctx, c.ws, t.ProjectID)
	if err != nil {
		return err
	}

	var patch store.TaskPatch
	changes := map[string]core.FieldChange{}
	// str applies one optional text field when it differs from what is there.
	str := func(name string, o Opt[string], cur *string, dst **string) {
		if !o.Set {
			return
		}
		v := o.V
		if o.Null {
			v = ""
		}
		if v == *cur {
			return
		}
		changes[name] = core.FieldChange{From: nullable(*cur), To: nullable(v)}
		*cur = v
		*dst = &v
	}

	if a.Title.Set && strings.TrimSpace(a.Title.V) == "" {
		return invalid("title", "a task needs a title")
	}
	a.Title.V = strings.TrimSpace(a.Title.V)
	str("title", a.Title, &t.Title, &patch.Title)
	str("description", a.Description, &t.Description, &patch.Description)

	if a.StatusID.Set && a.StatusID.V != t.StatusID {
		st, err := c.statusIn(p, a.StatusID.V)
		if err != nil {
			return err
		}
		str("status_id", a.StatusID, &t.StatusID, &patch.StatusID)
		started, completed, canceled := t.StartedAt, t.CompletedAt, t.CanceledAt
		stampStatus(&started, &completed, &canceled, st.Category, c.at)
		if started != t.StartedAt {
			t.StartedAt, patch.StartedAt = started, &started
		}
		if completed != t.CompletedAt {
			t.CompletedAt, patch.CompletedAt = completed, &completed
		}
		if canceled != t.CanceledAt {
			t.CanceledAt, patch.CanceledAt = canceled, &canceled
		}
	}
	if a.Priority.Set && a.Priority.V != t.Priority {
		if a.Priority.Null || a.Priority.V < 0 || a.Priority.V > 4 {
			return invalid("priority", "priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)")
		}
		changes["priority"] = core.FieldChange{From: t.Priority, To: a.Priority.V}
		v := a.Priority.V
		t.Priority, patch.Priority = v, &v
	}
	if a.AssigneeID.Set && !a.AssigneeID.Null && a.AssigneeID.V != "" {
		if _, err := c.member("assignee_id", a.AssigneeID.V); err != nil {
			return err
		}
	}
	str("assignee_id", a.AssigneeID, &t.AssigneeID, &patch.AssigneeID)
	if a.WaitingOnID.Set && !a.WaitingOnID.Null && a.WaitingOnID.V != "" {
		if _, err := c.member("waiting_on_id", a.WaitingOnID.V); err != nil {
			return err
		}
	}
	str("waiting_on_id", a.WaitingOnID, &t.WaitingOnID, &patch.WaitingOnID)
	str("waiting_on_note", a.WaitingOnNote, &t.WaitingOnNote, &patch.WaitingOnNote)
	if a.ParentID.Set && !a.ParentID.Null && a.ParentID.V != "" && a.ParentID.V != t.ParentID {
		if err := c.checkParent(t, a.ParentID.V); err != nil {
			return err
		}
	}
	str("parent_id", a.ParentID, &t.ParentID, &patch.ParentID)
	if a.DueOn.Set && !a.DueOn.Null {
		if err := checkDate("due_on", a.DueOn.V); err != nil {
			return err
		}
	}
	str("due_on", a.DueOn, &t.DueOn, &patch.DueOn)
	if a.Rank.Set {
		if a.Rank.Null || !rank.Valid(a.Rank.V) {
			return invalid("rank", "%q is not a rank", a.Rank.V)
		}
		str("rank", a.Rank, &t.Rank, &patch.Rank)
	}

	have := map[string]bool{}
	for _, l := range t.LabelIDs {
		have[l] = true
	}
	var added, removed []string
	for _, l := range a.AddLabelIDs {
		if have[l] {
			continue
		}
		if err := c.labelFor(p, l); err != nil {
			return err
		}
		have[l] = true
		added = append(added, l)
	}
	for _, l := range a.RemoveLabelIDs {
		if have[l] {
			have[l] = false
			removed = append(removed, l)
		}
	}

	if len(changes) == 0 && len(added) == 0 && len(removed) == 0 {
		return nil // already as asked: nothing to write, no event
	}
	seq := c.tx.NextSeq()
	if err := c.tx.UpdateTask(c.ctx, c.ws, t.ID, patch, seq, c.at); err != nil {
		return err
	}
	for _, l := range added {
		if err := c.tx.AddTaskLabel(c.ctx, c.ws, t.ID, l); err != nil {
			return err
		}
	}
	for _, l := range removed {
		if err := c.tx.RemoveTaskLabel(c.ctx, c.ws, t.ID, l); err != nil {
			return err
		}
	}
	data := map[string]any{"key": t.Key}
	if len(changes) > 0 {
		data["changes"] = changes
	}
	if len(added) > 0 {
		data["labels_added"] = added
	}
	if len(removed) > 0 {
		data["labels_removed"] = removed
	}
	return c.emit(seq, "task.updated", "task", t.ID, "task", t.ID, t.ProjectID, data)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// checkParent refuses a parent that would make a loop.
func (c *cx) checkParent(t core.Task, parentID string) error {
	cur := parentID
	for depth := 0; cur != ""; depth++ {
		if cur == t.ID {
			return invalid("parent_id", "a task cannot be its own ancestor")
		}
		if depth > 50 {
			return invalid("parent_id", "sub-tasks are nested too deep")
		}
		p, err := c.tx.Task(c.ctx, c.ws, cur)
		if err != nil {
			return missing(err, "parent task", cur)
		}
		cur = p.ParentID
	}
	return nil
}

// setWaitingOn hands a task to userID ("" = nobody) as part of another
// change, and says so in the feed.
func (c *cx) setWaitingOn(t core.Task, userID string) error {
	if t.WaitingOnID == userID {
		return nil
	}
	seq := c.tx.NextSeq()
	if err := c.tx.UpdateTask(c.ctx, c.ws, t.ID, store.TaskPatch{WaitingOnID: &userID}, seq, c.at); err != nil {
		return err
	}
	return c.emit(seq, "task.updated", "task", t.ID, "task", t.ID, t.ProjectID, map[string]any{
		"key":     t.Key,
		"changes": map[string]core.FieldChange{"waiting_on_id": {From: nullable(t.WaitingOnID), To: nullable(userID)}},
	})
}

type taskRefArgs struct {
	ID string `json:"id"`
}

func taskDelete(c *cx) error {
	var a taskRefArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.liveTask(a.ID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	by := c.actor.UserID
	if err := c.tx.UpdateTask(c.ctx, c.ws, t.ID, store.TaskPatch{DeletedAt: &c.at, DeletedBy: &by}, seq, c.at); err != nil {
		return err
	}
	return c.emit(seq, "task.deleted", "task", t.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key})
}

func taskRestore(c *cx) error {
	var a taskRefArgs
	if err := c.args(&a); err != nil {
		return err
	}
	if a.ID == "" {
		return invalid("id", "the task id is required")
	}
	t, err := c.tx.Task(c.ctx, c.ws, a.ID)
	if err != nil {
		return missing(err, "task", a.ID)
	}
	if t.DeletedAt == 0 {
		return nil // not in the trash: nothing to do
	}
	seq := c.tx.NextSeq()
	var zero int64
	none := ""
	if err := c.tx.UpdateTask(c.ctx, c.ws, t.ID, store.TaskPatch{DeletedAt: &zero, DeletedBy: &none}, seq, c.at); err != nil {
		return err
	}
	return c.emit(seq, "task.restored", "task", t.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key})
}

// ---- comments ----

type commentCreateArgs struct {
	ID          string `json:"id"`
	TaskID      string `json:"task_id"`
	Body        string `json:"body"`
	SubjectType string `json:"subject_type"` // task (default), decision, decision_option
	SubjectID   string `json:"subject_id"`
	ParentID    string `json:"parent_id"`
}

func commentCreate(c *cx) error {
	var a commentCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if a.TaskID == "" {
		return invalid("task_id", "task_id is required")
	}
	t, err := c.liveTask(a.TaskID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Body) == "" {
		return invalid("body", "a comment needs text")
	}
	subjectType, subjectID := a.SubjectType, a.SubjectID
	switch subjectType {
	case "", "task":
		subjectType, subjectID = "task", t.ID
	case "decision", "decision_option":
		if err := c.subjectInTask(t, subjectType, subjectID); err != nil {
			return err
		}
	default:
		return &Error{Code: CodeInvalid, Field: "subject_type", Message: "unknown subject_type " + subjectType,
			Allowed: []string{"task", "decision", "decision_option"}}
	}
	seq := c.tx.NextSeq()
	cm := core.Comment{ID: cid, TaskID: t.ID, SubjectType: subjectType, SubjectID: subjectID, ParentID: a.ParentID,
		AuthorID: c.actor.UserID, Body: a.Body, CreatedAt: c.at, CreatedSeq: seq}
	if err := c.tx.InsertComment(c.ctx, c.ws, cm); err != nil {
		return taken(err, "id", cid)
	}
	// A comment is activity on its task: this is what lets "what is new on
	// my tasks" see it.
	if err := c.tx.TouchTask(c.ctx, c.ws, t.ID, seq); err != nil {
		return err
	}
	return c.emit(seq, "comment.created", "comment", cm.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key, "comment": cm})
}

// subjectInTask checks that a decision, or an option of one, belongs to t.
func (c *cx) subjectInTask(t core.Task, subjectType, subjectID string) error {
	if subjectID == "" {
		return invalid("subject_id", "subject_id is required for a comment on a %s", strings.ReplaceAll(subjectType, "_", " "))
	}
	if subjectType == "decision" {
		d, err := c.tx.Decision(c.ctx, c.ws, subjectID)
		if err != nil {
			return missing(err, "decision", subjectID)
		}
		if d.TaskID != t.ID {
			return invalid("subject_id", "that decision belongs to another task")
		}
		return nil
	}
	decisionID, err := c.tx.DecisionOfOption(c.ctx, c.ws, subjectID)
	if err != nil {
		return missing(err, "option", subjectID)
	}
	return c.subjectInTask(t, "decision", decisionID)
}

// ---- decisions ----

type optionArgs struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type decisionOpenArgs struct {
	ID       string       `json:"id"`
	TaskID   string       `json:"task_id"`
	Kind     string       `json:"kind"` // choice (default when options are given) or approval
	Question string       `json:"question"`
	Options  []optionArgs `json:"options"`
	// Recommended is the id of the option the asker would pick, or its
	// position in options starting at 1.
	RecommendedOptionID string `json:"recommended_option_id"`
	Recommended         int    `json:"recommended"`
	Recommendation      string `json:"recommendation"`
	// Ask is who should answer. The task then waits on them.
	Ask string `json:"ask"`
}

func decisionOpen(c *cx) error {
	var a decisionOpenArgs
	if err := c.args(&a); err != nil {
		return err
	}
	did, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if a.TaskID == "" {
		return invalid("task_id", "task_id is required")
	}
	t, err := c.liveTask(a.TaskID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Question) == "" {
		return invalid("question", "a decision needs a question")
	}
	kind := a.Kind
	if kind == "" {
		kind = core.DecisionChoice
		if len(a.Options) == 0 {
			kind = core.DecisionApproval
		}
	}
	switch kind {
	case core.DecisionChoice:
		if len(a.Options) < 2 {
			return invalid("options", "a choice needs at least two options; for a plain yes or no use kind \"approval\"")
		}
	case core.DecisionApproval:
		if len(a.Options) > 0 {
			return invalid("options", "an approval has no options: it is answered approved or declined")
		}
	default:
		return &Error{Code: CodeInvalid, Field: "kind", Message: "unknown kind " + kind,
			Allowed: []string{core.DecisionChoice, core.DecisionApproval}}
	}
	if a.Ask != "" {
		if _, err := c.member("ask", a.Ask); err != nil {
			return err
		}
	}

	d := core.Decision{ID: did, TaskID: t.ID, Kind: kind, Question: strings.TrimSpace(a.Question), State: core.StateOpen,
		Recommendation: a.Recommendation, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	seen := map[string]bool{}
	for i, o := range a.Options {
		oid, err := newID("options.id", o.ID)
		if err != nil {
			return err
		}
		if seen[oid] {
			return invalid("options", "two options share the id %s", oid)
		}
		seen[oid] = true
		if strings.TrimSpace(o.Label) == "" {
			return invalid("options", "option %d needs a label", i+1)
		}
		d.Options = append(d.Options, core.Option{ID: oid, DecisionID: did, Label: strings.TrimSpace(o.Label),
			Description: o.Description, Rank: rank.ForNumber(i + 1)})
	}
	switch {
	case a.RecommendedOptionID != "":
		if !seen[a.RecommendedOptionID] {
			return invalid("recommended_option_id", "the recommended option is not one of the options")
		}
		d.RecommendedOptionID = a.RecommendedOptionID
	case a.Recommended != 0:
		if a.Recommended < 1 || a.Recommended > len(d.Options) {
			return invalid("recommended", "recommended is the position of an option, 1 to %d", len(d.Options))
		}
		d.RecommendedOptionID = d.Options[a.Recommended-1].ID
	}

	// Decisions keep the order they were asked in.
	existing, err := c.tx.CountDecisions(c.ctx, c.ws, t.ID)
	if err != nil {
		return err
	}
	d.Rank = rank.ForNumber(existing + 1)
	seq := c.tx.NextSeq()
	d.UpdatedSeq = seq
	if err := c.tx.InsertDecision(c.ctx, c.ws, d, seq); err != nil {
		return taken(err, "id", did)
	}
	for _, o := range d.Options {
		if err := c.tx.InsertOption(c.ctx, c.ws, o, c.at); err != nil {
			return taken(err, "option id", o.ID)
		}
	}
	if err := c.tx.TouchTask(c.ctx, c.ws, t.ID, seq); err != nil {
		return err
	}
	if err := c.emit(seq, "decision.opened", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key, "decision": d}); err != nil {
		return err
	}
	if a.Ask != "" {
		return c.setWaitingOn(t, a.Ask)
	}
	return nil
}

type decisionPickArgs struct {
	ID       string `json:"id"`
	OptionID string `json:"option_id"`
	Outcome  string `json:"outcome"`
	Note     string `json:"note"`
}

func decisionPick(c *cx) error {
	var a decisionPickArgs
	if err := c.args(&a); err != nil {
		return err
	}
	if a.ID == "" {
		return invalid("id", "the decision id is required")
	}
	d, err := c.tx.Decision(c.ctx, c.ws, a.ID)
	if err != nil {
		return missing(err, "decision", a.ID)
	}
	t, err := c.liveTask(d.TaskID)
	if err != nil {
		return err
	}
	// The first answer stands. A second one is refused, not merged.
	if d.State != core.StateOpen {
		return conflictErr("this decision was already answered (%s); open a new one to ask again", d.State)
	}
	if d.CreatedBy == c.actor.UserID {
		return forbidden("you asked this question, so someone else has to answer it")
	}

	outcome := a.Outcome
	state := core.StatePicked
	if d.Kind == core.DecisionApproval {
		if a.OptionID != "" {
			return invalid("option_id", "an approval has no options")
		}
		switch outcome {
		case core.OutcomeApproved:
		case core.OutcomeDeclined:
			state = core.StateSentBack
		default:
			return &Error{Code: CodeInvalid, Field: "outcome", Message: "an approval is answered approved or declined",
				Allowed: []string{core.OutcomeApproved, core.OutcomeDeclined}}
		}
	} else {
		if outcome == "" && a.OptionID != "" {
			outcome = core.OutcomeAsIs
		}
		switch outcome {
		case core.OutcomeAsIs, core.OutcomeWithChanges:
			if !hasOption(d, a.OptionID) {
				return &Error{Code: CodeInvalid, Field: "option_id", Message: "option_id must be one of this decision's options", Allowed: optionIDs(d)}
			}
			if outcome == core.OutcomeWithChanges && strings.TrimSpace(a.Note) == "" {
				return invalid("note", "\"with_changes\" needs a note saying what to change")
			}
		case core.OutcomeNone:
			if a.OptionID != "" {
				return invalid("option_id", "outcome \"none\" picks no option")
			}
			state = core.StateSentBack
		default:
			return &Error{Code: CodeInvalid, Field: "outcome", Message: "a choice is answered with an option, or sent back",
				Allowed: []string{core.OutcomeAsIs, core.OutcomeWithChanges, core.OutcomeNone}}
		}
	}

	by := c.actor.UserID
	seq := c.tx.NextSeq()
	if err := c.tx.UpdateDecision(c.ctx, c.ws, d.ID, store.DecisionPatch{
		State: &state, PickedOptionID: &a.OptionID, Outcome: &outcome, OutcomeNote: &a.Note, DecidedBy: &by, DecidedAt: &c.at,
	}, seq, c.at); err != nil {
		return err
	}
	d.State, d.PickedOptionID, d.Outcome, d.OutcomeNote, d.DecidedBy, d.DecidedAt, d.UpdatedSeq = state, a.OptionID, outcome, a.Note, by, c.at, seq
	if err := c.tx.TouchTask(c.ctx, c.ws, t.ID, seq); err != nil {
		return err
	}
	if err := c.emit(seq, "decision.picked", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key, "decision": d}); err != nil {
		return err
	}
	// The answer is in, so the next move is the asker's.
	if _, err := c.tx.Member(c.ctx, c.ws, d.CreatedBy); err == nil {
		return c.setWaitingOn(t, d.CreatedBy)
	}
	return nil
}

func hasOption(d core.Decision, optionID string) bool {
	for _, o := range d.Options {
		if o.ID == optionID {
			return optionID != ""
		}
	}
	return false
}

func optionIDs(d core.Decision) []string {
	out := make([]string, len(d.Options))
	for i, o := range d.Options {
		out[i] = o.ID
	}
	return out
}
