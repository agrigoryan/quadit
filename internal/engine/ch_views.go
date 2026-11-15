package engine

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

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
	if !contains(viewLayouts, a.Layout) {
		return oneOf("layout", "layout", a.Layout, viewLayouts)
	}
	v := core.View{ID: vid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Description: a.Description, Icon: a.Icon,
		OwnerID: c.actor.UserID, Shared: a.Shared == nil || *a.Shared, Query: a.Query, Layout: a.Layout, Display: a.Display, CreatedAt: c.at}
	if len(a.Query) > 0 {
		if err := c.checkViewQuery(a.Project, a.Query); err != nil {
			return err
		}
		if err := c.checkViewValues(a.Query); err != nil {
			return err
		}
	}
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		v.ProjectID = p.ID
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
	return c.emit(event{seq: seq, typ: "view.created", entity: "view", entityID: v.ID, place: c.inProjectOrWorkspace(v.ProjectID), audience: audience, data: map[string]any{"row": v}})
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
		if !contains(viewLayouts, a.Layout.V) {
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
		if err := c.checkViewValues(a.Query.V); err != nil {
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

// checkViewValues refuses a filter that names a status or a label the
// workspace does not have, or an ordering there is none of: such a view
// would save and then fail every time it is opened.
func (c *cx) checkViewValues(raw json.RawMessage) error {
	var q struct {
		Status   []string `json:"status"`
		Label    []string `json:"label"`
		Sort     string   `json:"sort"`
		Assignee []string `json:"assignee"`
		Epic     []string `json:"epic"`
		Priority []int    `json:"priority"`
		Category []string `json:"category"`
		Creator  string   `json:"creator"`
		Parent   string   `json:"parent"`
		Asked    string   `json:"asked"`
		Mentions string   `json:"mentions"`
	}
	if err := json.Unmarshal(raw, &q); err != nil {
		return nil //nolint:nilerr // a query of another shape is CheckViewQuery's to refuse, and it has had its say
	}
	for _, p := range q.Priority {
		if !priorityOK(p) {
			return invalid("query.priority", "priority is 0 (none) to 4 (low): 1 urgent, 2 high, 3 medium, 4 low; %d is none of them", p)
		}
	}
	for _, cat := range q.Category {
		if !core.ValidCategory(strings.ToLower(cat)) {
			return oneOf("query.category", "category", cat, core.Categories)
		}
	}
	people := []viewPeople{{"query.assignee", q.Assignee}, {"query.creator", []string{q.Creator}},
		{"query.asked", []string{q.Asked}}, {"query.mentions", []string{q.Mentions}}}
	if err := c.checkViewPeople(people, q.Parent); err != nil {
		return err
	}
	if err := c.checkViewEpics(q.Epic); err != nil {
		return err
	}
	if err := checkViewSort(q.Sort); err != nil {
		return err
	}
	if err := c.checkViewStatuses(q.Status); err != nil {
		return err
	}
	return c.checkViewLabels(q.Label)
}

// viewPeople is one filter of a view that names members.
type viewPeople struct {
	field string
	refs  []string
}

// checkViewPeople refuses a filter on a member, or on a parent task, that
// is not there. The filters are checked in the order given, so a view with
// more than one wrong is always told of the same one.
func (c *cx) checkViewPeople(people []viewPeople, parent string) error {
	for _, f := range people {
		for _, ref := range f.refs {
			if ref == "" || ref == "me" || ref == "none" {
				continue
			}
			if _, err := c.memberRef(f.field, ref); err != nil {
				var e *Error
				if errors.As(err, &e) {
					e.Code = CodeInvalid // the view is what is wrong, not the address asked
				}
				return err
			}
		}
	}
	if parent != "" {
		if _, err := c.anyTask("query.parent", parent); err != nil {
			var e *Error
			if errors.As(err, &e) {
				e.Code = CodeInvalid
			}
			return err
		}
	}
	return nil
}

func (c *cx) checkViewEpics(refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	var all []core.Epic
	if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
		return err
	}
	for _, ref := range refs {
		names, found := []string{}, ref == "none"
		for _, e := range all {
			found = found || e.ID == ref || strings.EqualFold(e.Name, ref)
			names = append(names, e.Name)
		}
		if !found {
			sort.Strings(names)
			return oneOf("query.epic", "epic", ref, append(names, "none"))
		}
	}
	return nil
}

func checkViewSort(by string) error {
	if _, ok := store.TaskSortKeys[by]; !ok {
		var sorts []string
		for k := range store.TaskSortKeys {
			if k != "" {
				sorts = append(sorts, k)
			}
		}
		sort.Strings(sorts)
		return oneOf("query.sort", "sort", by, sorts)
	}
	return nil
}

func (c *cx) checkViewStatuses(refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	var all []core.Status
	if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
		return err
	}
	for _, ref := range refs {
		names, found := []string{}, core.ValidCategory(strings.ToLower(ref))
		for _, s := range all {
			found = found || s.ID == ref || strings.EqualFold(s.Name, ref)
			if !contains(names, s.Name) {
				names = append(names, s.Name)
			}
		}
		if !found {
			sort.Strings(names)
			return oneOf("query.status", "status", ref, append(names, core.Categories...))
		}
	}
	return nil
}

func (c *cx) checkViewLabels(refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	var all []core.Label
	if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
		return err
	}
	for _, ref := range refs {
		names, found := []string{}, false
		for _, l := range all {
			found = found || l.ID == ref || strings.EqualFold(l.Name, ref)
			if !contains(names, l.Name) {
				names = append(names, l.Name)
			}
		}
		if !found {
			sort.Strings(names)
			return oneOf("query.label", "label", ref, names)
		}
	}
	return nil
}

// CheckViewQuery says whether a saved view's filter can be read and run as
// it stands: every field known, every member, status, label, epic, task
// and date in it real. The server sets it, because the filter's fields are
// its task queries' and it resolves them the same way when the view is
// opened; a view that saves is then a view that opens.
var CheckViewQuery = func(ctx context.Context, db store.DB, actor core.Member, project string, q json.RawMessage) error {
	if !json.Valid(q) {
		return errors.New("query must be a JSON object")
	}
	return nil
}

func (c *cx) checkViewQuery(project string, q json.RawMessage) error {
	err := CheckViewQuery(c.ctx, c.tx, c.actor, project, q)
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		// What is wrong is the view, whatever the lookup inside called it.
		out := *e
		out.Code = CodeInvalid
		if !strings.HasPrefix(out.Field, "query") {
			out.Field = strings.TrimSuffix("query."+out.Field, ".")
		}
		return &out
	}
	return invalid("query", "%v", err)
}
