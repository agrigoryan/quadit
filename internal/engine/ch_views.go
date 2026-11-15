// view.create, view.update and view.delete: saved views and their filters.

package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers view.*.
func init() {
	register("view.create", core.RoleMember, viewCreate)
	register("view.update", core.RoleMember, viewUpdate)
	register("view.delete", core.RoleMember, viewDelete)
}

type viewCreateArgs struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Project     string          `json:"project"`
	Description string          `json:"description"`
	Icon        string          `json:"icon"`
	Query       json.RawMessage `json:"query"`   // the same filter object a task query takes
	Layout      string          `json:"layout"`  // list, board, timeline
	Display     json.RawMessage `json:"display"` // grouping, sorting, shown fields
	Shared      *bool           `json:"shared"`  // default true: everyone sees it
	Rank        string          `json:"rank"`
}

var viewLayouts = []string{"list", "board", "timeline"}

func slugify(s string) string {
	s = strings.Trim(handleStrip.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-"), "-_")
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		s = "view"
	}
	return s
}

// viewCreate saves a view: a filter on tasks with a name, shared or the
// owner's own.
func viewCreate(c *cx, a viewCreateArgs) error {
	vid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a view needs a name")
	}
	if a.Layout == "" {
		a.Layout = "list"
	}
	if !slices.Contains(viewLayouts, a.Layout) {
		return oneOf("layout", "layout", a.Layout, viewLayouts)
	}
	v := core.View{ID: vid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Description: a.Description, Icon: a.Icon,
		OwnerID: c.actor.UserID, Shared: a.Shared == nil || *a.Shared, Query: a.Query, Layout: a.Layout, Display: a.Display, CreatedAt: c.at}
	if len(a.Query) > 0 {
		if err := c.checkViewQuery(a.Project, a.Query); err != nil {
			return err
		}
	}
	if a.Project != "" {
		project, err := c.project(a.Project)
		if err != nil {
			return err
		}
		v.ProjectID = project.ID
	}
	base := slugify(v.Name)
	v.Slug = base
	for i := 2; ; i++ {
		n, err := c.tx.Count(c.ctx, "views", store.Eq("slug", v.Slug), store.Live)
		if err != nil {
			return err
		}
		if n == 0 {
			break
		}
		v.Slug = base + "-" + itoa(i)
	}
	if v.Rank = a.Rank; v.Rank == "" {
		if v.Rank, err = nextRank[core.View](c, store.Live); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	v.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, v); err != nil {
		return alreadyInUse(err, "id", vid)
	}
	c.ref, c.key = v.ID, v.Slug
	audience := ""
	if !v.Shared {
		audience = v.OwnerID
	}
	return c.emit(event{seq: seq, typ: "view.created", entity: "view", entityID: v.ID, place: c.inProjectOrWorkspace(v.ProjectID), audience: audience, data: core.EventData{Row: v}})
}

type viewUpdateArgs struct {
	ID          string               `json:"id"` // id or slug
	Name        Opt[string]          `json:"name"`
	Description Opt[string]          `json:"description"`
	Icon        Opt[string]          `json:"icon"`
	Query       Opt[json.RawMessage] `json:"query"`
	Layout      Opt[string]          `json:"layout"`
	Display     Opt[json.RawMessage] `json:"display"`
	Shared      Opt[bool]            `json:"shared"`
	Rank        Opt[string]          `json:"rank"`
}

func (c *cx) loadView(ref string) (core.View, error) {
	var v core.View
	cond := store.Eq("slug", ref)
	if isID(ref) {
		cond = store.Eq("id", ref)
	}
	if err := c.tx.Get(c.ctx, &v, cond, store.Live); err != nil {
		return v, missing(err, "view", ref)
	}
	if !v.Shared && v.OwnerID != c.actor.UserID {
		return v, notFound("view", ref)
	}
	if v.OwnerID != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return v, forbidden("only its owner, or an admin, can change a view")
	}
	return v, nil
}

// viewUpdate changes a saved view, by its owner or an admin.
func viewUpdate(c *cx, a viewUpdateArgs) error {
	v, err := c.loadView(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &v.Name); err != nil {
		return err
	}
	p.setText("description", a.Description, &v.Description)
	p.setText("icon", a.Icon, &v.Icon)
	if a.Layout.Set {
		if !slices.Contains(viewLayouts, a.Layout.V) {
			return oneOf("layout", "layout", a.Layout.V, viewLayouts)
		}
		p.setText("layout", a.Layout, &v.Layout)
	}
	raw := func(col string, o Opt[json.RawMessage], cur json.RawMessage) error {
		if !o.Set {
			return nil
		}
		if !o.Null && !json.Valid(o.V) {
			return invalid(col, "%s must be JSON", col)
		}
		if string(o.V) != string(cur) {
			p.set[col] = o.V
			p.changes[col] = core.FieldChange{From: cur, To: o.V}
		}
		return nil
	}
	if a.Query.Set && len(a.Query.V) > 0 {
		if err := c.checkViewQuery(v.ProjectID, a.Query.V); err != nil {
			return err
		}
	}
	if err := raw("query", a.Query, v.Query); err != nil {
		return err
	}
	if err := raw("display", a.Display, v.Display); err != nil {
		return err
	}
	p.setFlag("shared", a.Shared, &v.Shared)
	if err := p.rank(a.Rank, &v.Rank); err != nil {
		return err
	}
	return c.save(p, target{table: "views", entity: "view", id: v.ID, place: c.inProjectOrWorkspace(v.ProjectID)})
}

func viewDelete(c *cx, a idArgs) error {
	v, err := c.loadView(a.ID)
	if err != nil {
		return err
	}
	return c.trash(target{table: "views", entity: "view", id: v.ID, place: c.inProjectOrWorkspace(v.ProjectID)})
}

// checkViewQuery refuses a saved view's filter that a task list could not
// read as it stands: a field there is none of, a value of the wrong type, a
// date that is not one, a count below zero, a priority there is none of, or
// a member, status, label, epic, cycle, milestone or task that is not
// there. It reads the filter the way it will be read when the view is
// opened, as the one saving it (TaskFilter), so a view that saves is a view
// that opens. project is the view's own, which bounds the names when the
// filter names no project. Whatever is wrong, it is the view that is wrong:
// every refusal is "invalid" and names its field under "query".
func (c *cx) checkViewQuery(project string, raw json.RawMessage) error {
	var q core.TaskQuery
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields() // "labels" for "label" would otherwise match everything
	if err := dec.Decode(&q); err != nil {
		return invalid("query", "this filter cannot be read (%s). It is an object of task filters; lists such as label, status and assignee are written as lists: {\"label\": [\"art\"]}", PlainJSON(err))
	}
	wrong := func(err error) error {
		e, refused := errors.AsType[*Error](err)
		if !refused {
			return err
		}
		out := *e
		out.Code = CodeInvalid
		if !strings.HasPrefix(out.Field, "query") {
			out.Field = strings.TrimSuffix("query."+out.Field, ".")
		}
		return &out
	}
	for _, date := range []struct{ name, day string }{{"due_before", q.DueBefore}, {"due_after", q.DueAfter}} {
		if _, err := time.Parse("2006-01-02", date.day); date.day != "" && err != nil {
			return invalid("query."+date.name, "%s takes a date like 2026-03-31, and was given %s", date.name, strconv.Quote(date.day))
		}
	}
	for _, count := range []struct {
		name string
		n    int64
	}{{"changed_since", q.ChangedSince}, {"updated_since", q.UpdatedSince}, {"limit", int64(q.Limit)}, {"offset", int64(q.Offset)}} {
		if count.n < 0 {
			return invalid("query."+count.name, "%s cannot be less than 0", count.name)
		}
	}
	var readable []string
	if c.actor.Scope != nil && len(c.actor.Scope.Projects) > 0 {
		readable = c.actor.Scope.Projects
	}
	if project != "" && len(q.Project) == 0 {
		q.Project = []string{project}
	}
	if _, _, err := c.TaskFilter(q, readable); err != nil {
		return wrong(err)
	}
	for _, key := range q.Keys {
		if _, err := c.anyTask("task", key); err != nil {
			return wrong(err)
		}
	}
	for _, p := range q.Priority {
		if !priorityOK(p) {
			return invalid("query.priority", "priority is 0 (none) to 4 (low): 1 urgent, 2 high, 3 medium, 4 low; %d is none of them", p)
		}
	}
	return nil
}
