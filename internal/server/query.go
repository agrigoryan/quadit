package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// nameLookup turns ids into what people call things, for compact output.
type nameLookup struct {
	members  map[string]core.Member
	statuses map[string]core.Status
	labels   map[string]core.Label
	projects map[string]core.Project
	epics    map[string]core.Epic
	cycles   map[string]core.Cycle
	// milestones holds each milestone's name, by id.
	milestones map[string]string
}

// names returns the request's nameLookup: the workspace's small tables
// (members, statuses, labels, projects, epics, cycles, milestones), every
// row of them, deleted ones too, read on the first call and kept for the
// rest of the request.
func (x *c) names() (*nameLookup, error) {
	if x.nameCache != nil {
		return x.nameCache, nil
	}
	lookup := &nameLookup{members: map[string]core.Member{}, statuses: map[string]core.Status{}, labels: map[string]core.Label{},
		projects: map[string]core.Project{}, epics: map[string]core.Epic{}, cycles: map[string]core.Cycle{}, milestones: map[string]string{}}
	var members []core.Member
	var statuses []core.Status
	var labels []core.Label
	var projects []core.Project
	var epics []core.Epic
	var cycles []core.Cycle
	var milestones []core.Milestone
	ctx := x.ctx()
	for _, list := range []struct {
		into  any
		order string
	}{
		{&members, ""}, {&statuses, "rank"}, {&labels, ""}, {&projects, "rank"}, {&epics, ""}, {&cycles, ""}, {&milestones, ""},
	} {
		if err := x.db.List(ctx, list.into, store.Q{Order: list.order}); err != nil {
			return nil, err
		}
	}
	for _, member := range members {
		lookup.members[member.UserID] = member
	}
	for _, status := range statuses {
		lookup.statuses[status.ID] = status
	}
	for _, label := range labels {
		lookup.labels[label.ID] = label
	}
	for _, project := range projects {
		lookup.projects[project.ID] = project
	}
	for _, epic := range epics {
		lookup.epics[epic.ID] = epic
	}
	for _, cycle := range cycles {
		lookup.cycles[cycle.ID] = cycle
	}
	for _, milestone := range milestones {
		lookup.milestones[milestone.ID] = milestone.Name
	}
	x.nameCache = lookup
	return lookup, nil
}

// handle returns "@handle" for a user id, or "" for none.
func (n *nameLookup) handle(userID string) string {
	if userID == "" {
		return ""
	}
	if m, ok := n.members[userID]; ok {
		return "@" + m.Handle
	}
	return "@unknown"
}

func (n *nameLookup) labelNames(ids []string) []string {
	var out []string
	for _, l := range ids {
		if lb, ok := n.labels[l]; ok {
			out = append(out, lb.Name)
		}
	}
	return out
}

// TaskQuery is how tasks are asked for: in the URL of a task query, in the
// feed, and in a saved view. Names work everywhere ids do.
type TaskQuery struct {
	Project      []string `json:"project,omitempty"`
	Assignee     []string `json:"assignee,omitempty"` // me, @handle, none
	Creator      string   `json:"creator,omitempty"`
	Status       []string `json:"status,omitempty"`
	Category     []string `json:"category,omitempty"`
	Open         *bool    `json:"open,omitempty"`
	WaitingOn    string   `json:"waiting_on,omitempty"`
	HeldBy       string   `json:"held_by,omitempty"`
	Label        []string `json:"label,omitempty"`
	Epic         []string `json:"epic,omitempty"`  // names or ids, or none
	Cycle        []string `json:"cycle,omitempty"` // current, next, a number, an id, or none
	Milestone    string   `json:"milestone,omitempty"`
	Priority     []int    `json:"priority,omitempty"`
	DueBefore    string   `json:"due_before,omitempty"`
	DueAfter     string   `json:"due_after,omitempty"`
	Mentions     string   `json:"mentions,omitempty"`
	Watching     bool     `json:"watching,omitempty"`
	OpenDecision bool     `json:"has_open_decision,omitempty"`
	Asked        string   `json:"asked,omitempty"` // has an open decision asked of this member
	ChangedSince int64    `json:"changed_since,omitempty"`
	UpdatedSince int64    `json:"updated_since,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	TopLevel     bool     `json:"top_level,omitempty"`
	Q            string   `json:"q,omitempty"`
	Keys         []string `json:"keys,omitempty"`
	Trash        bool     `json:"trash,omitempty"`
	Archived     bool     `json:"archived,omitempty"`
	Sort         string   `json:"sort,omitempty"`
	Limit        int      `json:"limit,omitempty"`
	Offset       int      `json:"offset,omitempty"`
	// view is the saved view the filter came from. What such a filter
	// names may have been deleted since it was saved.
	view string
}

// fromURL fills a struct from URL parameters named like its JSON fields.
// Lists are comma-separated. Parameters in skip belong to the endpoint, and
// any other unknown one is refused with the nearest real name.
func fromURL(v url.Values, dst any, skip ...string) error {
	rv := reflect.ValueOf(dst).Elem()
	rt := rv.Type()
	fields := map[string]int{}
	var known []string
	for i := range rt.NumField() {
		name, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue // a field that is not a parameter
		}
		fields[name] = i
		known = append(known, name)
	}
	for name, vals := range v {
		if has(skip, name) || len(vals) == 0 {
			continue
		}
		i, ok := fields[name]
		if !ok {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: "unknown parameter " + strconv.Quote(name),
				Allowed: known, Nearest: nearestOf(name, known)}
		}
		f := rv.Field(i)
		raw := strings.Join(vals, ",")
		switch f.Interface().(type) {
		case string:
			f.SetString(raw)
		case []string:
			f.Set(reflect.ValueOf(splitList(raw)))
		case []int:
			var numbers []int
			for _, part := range splitList(raw) {
				n, err := strconv.Atoi(part)
				if err != nil {
					return errBad("%s: %q is not a number", name, part)
				}
				numbers = append(numbers, n)
			}
			f.Set(reflect.ValueOf(numbers))
		case int, int64:
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return errBad("%s: %q is not a number", name, raw)
			}
			f.SetInt(n)
		case bool:
			f.SetBool(truthy(raw))
		case *bool:
			b := truthy(raw)
			f.Set(reflect.ValueOf(&b))
		}
	}
	return nil
}

// truthy reads a flag's value: given without a value, or as 1, true or yes.
func truthy(s string) bool { return s == "1" || s == "true" || s == "yes" || s == "" }

// splitList reads a comma-separated list, leaving out empty items.
func splitList(s string) []string {
	var out []string
	for item := range strings.SplitSeq(s, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// nearestOf is the allowed name closest to what was given, for "did you
// mean", or "" when none is close (within two edits, ignoring case).
func nearestOf(got string, allowed []string) string {
	best, bestD := "", 3
	for _, a := range allowed {
		if d := levenshtein(strings.ToLower(got), strings.ToLower(a)); d < bestD {
			best, bestD = a, d
		}
	}
	return best
}

func levenshtein(a, b string) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

func (x *c) resolver() *engine.Resolver {
	return engine.NewResolver(x.ctx(), x.db, x.member, time.Now().UnixMilli())
}

// filter turns a TaskQuery into the store's filter, resolving every name
// and keeping the caller inside the projects it may read.
func (x *c) filter(q TaskQuery) (store.TaskFilter, error) {
	f := store.TaskFilter{Keys: upperAll(q.Keys), Priorities: q.Priorities(), DueBefore: q.DueBefore, DueAfter: q.DueAfter,
		ActivityAfter: q.ChangedSince, UpdatedAfter: q.UpdatedSince, OpenDecision: q.OpenDecision, TopLevel: q.TopLevel,
		Text: q.Q, InTrash: q.Trash, Archived: q.Archived, Sort: q.Sort, Limit: q.Limit, Offset: q.Offset, Categories: q.Category}
	names, err := x.names()
	if err != nil {
		return f, err
	}
	resolve := x.resolver()
	// The projects asked for, or every one the caller may read.
	var projects []core.Project
	for _, ref := range q.Project {
		project, err := resolve.Project(ref)
		if err != nil {
			return f, err
		}
		if !x.canProject(project.ID) {
			return f, errForbidden("your access does not include project %s", project.Key)
		}
		projects = append(projects, project)
		f.ProjectIDs = append(f.ProjectIDs, project.ID)
	}
	if len(projects) == 0 {
		for _, project := range names.projects {
			if project.DeletedAt == 0 && x.canProject(project.ID) {
				projects = append(projects, project)
			}
		}
		if x.projects != nil {
			f.ProjectIDs = x.projects
		}
	}
	for _, category := range q.Category {
		if !core.ValidCategory(category) {
			return f, &engine.Error{Code: engine.CodeInvalid, Field: "category", Message: "unknown category " + strconv.Quote(category), Allowed: core.Categories}
		}
	}
	if q.Open != nil {
		if *q.Open {
			f.Open = true
		} else {
			f.Categories = append(f.Categories, core.CatDone, core.CatCanceled)
		}
	}
	// Members, by handle or "me".
	member := func(field, ref string) (string, error) {
		if ref == "" {
			return "", nil
		}
		found, err := resolve.Member(field, ref)
		return found.UserID, err
	}
	for _, a := range q.Assignee {
		if a == "none" {
			f.Unassigned = true
			continue
		}
		uid, err := member("assignee", a)
		if err != nil {
			return f, err
		}
		f.AssigneeIDs = append(f.AssigneeIDs, uid)
	}
	if f.CreatedBy, err = member("creator", q.Creator); err != nil {
		return f, err
	}
	switch strings.ToLower(q.WaitingOn) {
	case "outside", "external", "event":
		f.WaitingOutside, q.WaitingOn = true, ""
	case "none", "nobody":
		f.WaitingNobody, q.WaitingOn = true, ""
	}
	if f.WaitingOnID, err = member("waiting_on", q.WaitingOn); err != nil {
		return f, err
	}
	if f.LeaseHolderID, err = member("held_by", q.HeldBy); err != nil {
		return f, err
	}
	if f.MentionsID, err = member("mentions", q.Mentions); err != nil {
		return f, err
	}
	if f.AskedID, err = member("asked", q.Asked); err != nil {
		return f, err
	}
	if q.Watching {
		f.WatchedBy = x.member.UserID
	}
	// Statuses, labels and epics by name, among those of the projects; a
	// status may also be a category.
	inScope := func(projectID string) bool {
		return slices.ContainsFunc(projects, func(project core.Project) bool { return project.ID == projectID })
	}
	for _, ref := range q.Status {
		low := strings.ToLower(ref)
		var found bool
		var allowed []string
		for _, status := range names.statuses {
			if status.DeletedAt != 0 || !inScope(status.ProjectID) {
				continue
			}
			if status.ID == ref || strings.ToLower(status.Name) == low {
				f.StatusIDs = append(f.StatusIDs, status.ID)
				found = true
			}
			if !has(allowed, status.Name) {
				allowed = append(allowed, status.Name)
			}
		}
		if !found && core.ValidCategory(low) {
			f.Categories = append(f.Categories, low)
			found = true
		}
		if !found && q.view != "" {
			x.noteStaleView(q.view, "a status")
			continue
		}
		if !found {
			sort.Strings(allowed)
			return f, &engine.Error{Code: engine.CodeInvalid, Field: "status", Message: "no status " + strconv.Quote(ref),
				Allowed: append(allowed, core.Categories...), Nearest: nearestOf(ref, allowed)}
		}
	}
	for _, ref := range q.Label {
		low := strings.ToLower(ref)
		var ids, allowed []string
		for _, l := range names.labels {
			if l.DeletedAt != 0 || (l.ProjectID != "" && !inScope(l.ProjectID)) {
				continue
			}
			if l.ID == ref || strings.ToLower(l.Name) == low {
				ids = append(ids, l.ID)
			}
			allowed = append(allowed, l.Name)
		}
		switch len(ids) {
		case 1:
			f.LabelIDs = append(f.LabelIDs, ids[0])
		case 0:
			if q.view != "" {
				x.noteStaleView(q.view, "a label")
				continue
			}
			sort.Strings(allowed)
			return f, &engine.Error{Code: engine.CodeInvalid, Field: "label", Message: "no label " + strconv.Quote(ref), Allowed: allowed, Nearest: nearestOf(ref, allowed)}
		default:
			return f, errBad("several projects have a label %q: add project=KEY", ref)
		}
	}
	for _, ref := range q.Epic {
		if ref == "none" {
			f.NoEpic = true
			continue
		}
		low := strings.ToLower(ref)
		var found bool
		var allowed []string
		for _, e := range names.epics {
			if e.DeletedAt != 0 || !inScope(e.ProjectID) {
				continue
			}
			if e.ID == ref || strings.ToLower(e.Name) == low {
				f.EpicIDs = append(f.EpicIDs, e.ID)
				found = true
			}
			allowed = append(allowed, e.Name)
		}
		if !found && q.view != "" {
			x.noteStaleView(q.view, "an epic")
			continue
		}
		if !found {
			sort.Strings(allowed)
			return f, &engine.Error{Code: engine.CodeInvalid, Field: "epic", Message: "no epic " + strconv.Quote(ref), Allowed: allowed, Nearest: nearestOf(ref, allowed)}
		}
	}
	// Cycles, by number or as current or next, in each of the projects.
	for _, ref := range q.Cycle {
		if ref == "none" {
			f.NoCycle = true
			continue
		}
		var found bool
		for _, project := range projects {
			if cy, err := resolve.Cycle(project, ref); err == nil {
				f.CycleIDs = append(f.CycleIDs, cy.ID)
				found = true
			}
		}
		if !found && (ref == "current" || ref == "next") {
			// No cycle is running (or none comes next): nothing is in it.
			f.CycleIDs = append(f.CycleIDs, "no-such-cycle")
			continue
		}
		if !found {
			return f, errBad("no cycle %q: use current, next, a cycle number or none", ref)
		}
	}
	if q.Milestone != "" {
		// By id, or by name (among the milestones of the projects asked for).
		f.MilestoneID = q.Milestone
		if len(q.Milestone) != idLength {
			var milestones []core.Milestone
			if err := x.db.List(x.ctx(), &milestones, store.Where(store.Live)); err != nil {
				return f, err
			}
			var allowed []string
			f.MilestoneID = ""
			for _, milestone := range milestones {
				allowed = append(allowed, milestone.Name)
				if strings.EqualFold(milestone.Name, q.Milestone) {
					f.MilestoneID = milestone.ID
				}
			}
			if f.MilestoneID == "" {
				return f, &engine.Error{Code: engine.CodeNotFound, Field: "milestone", Message: "no milestone " + strconv.Quote(q.Milestone), Allowed: allowed, Nearest: nearestOf(q.Milestone, allowed)}
			}
		}
	}
	if q.Parent != "" {
		t, err := resolve.Task(q.Parent)
		if err != nil {
			return f, err
		}
		f.ParentID = t.ID
	}
	if _, ok := store.TaskSortKeys[f.Sort]; !ok {
		return f, &engine.Error{Code: engine.CodeInvalid, Field: "sort", Message: "unknown sort " + strconv.Quote(f.Sort), Allowed: sortNames}
	}
	return f, nil
}

var sortNames = []string{"created", "-created", "rank", "priority", "due", "-activity", "-updated", "key"}

// Priorities returns the priority filter.
func (q TaskQuery) Priorities() []int { return q.Priority }

func upperAll(list []string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = strings.ToUpper(s)
	}
	return out
}

// idLength is the length of an id (a UUID): a reference that long is taken
// as an id, any other as a name.
const idLength = 36

// queryFromRequest builds a TaskQuery from a saved view (when view= names
// one) overlaid with the URL's own parameters. skip names the endpoint's
// own parameters, which are not task filters. The view is found by id, by
// slug, or by its name as the sidebar shows it, among the caller's own
// views and the shared ones. since= is read as changed_since=, and a
// priority may be given by name.
func (x *c) queryFromRequest(skip ...string) (TaskQuery, error) {
	var q TaskQuery
	v := x.r.URL.Query()
	if slug := v.Get("view"); slug != "" {
		// The saved view: its filter is the base the URL adds to.
		var view core.View
		cond := store.Eq("slug", slug)
		if len(slug) == idLength {
			cond = store.Eq("id", slug)
		}
		err := x.db.Get(x.ctx(), &view, cond, store.Live)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return q, err
		}
		if err != nil {
			// By its name, as it reads in the sidebar.
			var named []core.View
			if err := x.db.List(x.ctx(), &named, store.Where(store.Live)); err != nil {
				return q, err
			}
			for _, candidate := range named {
				if strings.EqualFold(candidate.Name, slug) && (candidate.Shared || candidate.OwnerID == x.member.UserID) {
					view, err = candidate, nil
					break
				}
			}
		}
		if err != nil || (!view.Shared && view.OwnerID != x.member.UserID) {
			var all []core.View
			if err := x.db.List(x.ctx(), &all, store.Where(store.Live)); err != nil {
				return q, err
			}
			var slugs []string
			for _, other := range all {
				if other.Shared || other.OwnerID == x.member.UserID {
					slugs = append(slugs, other.Slug)
				}
			}
			return q, &engine.Error{Code: engine.CodeNotFound, Field: "view", Message: "no view " + strconv.Quote(slug), Allowed: slugs, Nearest: nearestOf(slug, slugs)}
		}
		if len(view.Query) > 0 {
			if err := json.Unmarshal(view.Query, &q); err != nil {
				return q, &engine.Error{Code: engine.CodeInvalid, Field: "view", Message: fmt.Sprintf("the view %s has a filter that cannot be read (%s); save it again with view.update", view.Slug, engine.PlainJSON(err))}
			}
		}
		if view.ProjectID != "" && len(q.Project) == 0 {
			q.Project = []string{view.ProjectID}
		}
		q.view = view.Slug
	}
	// since= means the same here as on every list: what changed after that
	// position in the feed.
	if s := v.Get("since"); s != "" && v.Get("changed_since") == "" {
		v = cloneValues(v)
		v.Set("changed_since", s)
	}
	// A priority may be asked for by name.
	if priorities := v["priority"]; len(priorities) > 0 {
		var nums []string
		for _, priority := range splitList(strings.Join(priorities, ",")) {
			found := false
			for n, name := range engine.PriorityNames {
				if strings.EqualFold(priority, name) {
					nums, found = append(nums, strconv.Itoa(n)), true
				}
			}
			if _, err := strconv.Atoi(priority); err == nil {
				nums, found = append(nums, priority), true
			}
			if !found {
				return q, &engine.Error{Code: engine.CodeInvalid, Field: "priority", Message: "unknown priority " + strconv.Quote(priority), Allowed: engine.PriorityNames, Nearest: nearestOf(priority, engine.PriorityNames)}
			}
		}
		v = cloneValues(v)
		v["priority"] = []string{strings.Join(nums, ",")}
	}
	err := fromURL(v, &q, append(skip, "view", "format", "fields", "count", "raw", "since", "cursor")...)
	return q, err
}

func init() {
	// A view is saved only with a filter that task queries can read.
	engine.CheckViewQuery = func(ctx context.Context, db store.DB, actor core.Member, project string, raw json.RawMessage) error {
		var q TaskQuery
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields() // "labels" for "label" would otherwise match everything
		if err := dec.Decode(&q); err != nil {
			return fmt.Errorf("this filter cannot be read (%s). It is an object of task filters; lists such as label, status and assignee are written as lists: {\"label\": [\"art\"]}", engine.PlainJSON(err))
		}
		for name, day := range map[string]string{"due_before": q.DueBefore, "due_after": q.DueAfter} {
			if _, err := time.Parse("2006-01-02", day); day != "" && err != nil {
				return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " takes a date like 2026-03-31, and was given " + strconv.Quote(day)}
			}
		}
		for name, n := range map[string]int64{"changed_since": q.ChangedSince, "updated_since": q.UpdatedSince, "limit": int64(q.Limit), "offset": int64(q.Offset)} {
			if n < 0 {
				return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " cannot be less than 0"}
			}
		}
		// Resolved the way it will be when the view is opened, by the one
		// saving it: a name that finds nothing is refused now.
		x := &c{db: db, member: actor, r: (&http.Request{}).WithContext(ctx)}
		if actor.Scope != nil && len(actor.Scope.Projects) > 0 {
			x.projects = actor.Scope.Projects
		}
		if project != "" && len(q.Project) == 0 {
			q.Project = []string{project}
		}
		if _, err := x.filter(q); err != nil { //nolint:contextcheck // x carries ctx in its request, as every handler's does
			return err
		}
		for _, key := range q.Keys {
			if _, err := x.resolver().Task(key); err != nil { //nolint:contextcheck // x carries ctx in its request
				return err
			}
		}
		return nil
	}
}

// noteStaleView notes that a saved view names something deleted since it was saved.
// The list is read without that part, as the web app shows it, and says so.
func (x *c) noteStaleView(view, what string) {
	if x.staleView == "" {
		x.staleView = fmt.Sprintf("the view %s filters by %s that no longer exists; that part was left out. Save the view again (view.update) to drop it", view, what)
	}
}

func cloneValues(v url.Values) url.Values {
	out := url.Values{}
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}
