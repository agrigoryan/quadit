package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// names turns ids into what people call things, for compact output.
type names struct {
	members  map[string]core.Member
	statuses map[string]core.Status
	labels   map[string]core.Label
	projects map[string]core.Project
	epics    map[string]core.Epic
	cycles   map[string]core.Cycle
}

// names loads the workspace's small tables once per request.
func (x *c) names() (*names, error) {
	if x.nm != nil {
		return x.nm, nil
	}
	n := &names{members: map[string]core.Member{}, statuses: map[string]core.Status{}, labels: map[string]core.Label{},
		projects: map[string]core.Project{}, epics: map[string]core.Epic{}, cycles: map[string]core.Cycle{}}
	var ms []core.Member
	var ss []core.Status
	var ls []core.Label
	var ps []core.Project
	var es []core.Epic
	var cs []core.Cycle
	ctx := x.ctx()
	for _, load := range []func() error{
		func() error { return x.db.List(ctx, &ms, store.Q{}) },
		func() error { return x.db.List(ctx, &ss, store.Q{Order: "rank"}) },
		func() error { return x.db.List(ctx, &ls, store.Q{}) },
		func() error { return x.db.List(ctx, &ps, store.Q{Order: "rank"}) },
		func() error { return x.db.List(ctx, &es, store.Q{}) },
		func() error { return x.db.List(ctx, &cs, store.Q{}) },
	} {
		if err := load(); err != nil {
			return nil, err
		}
	}
	for _, m := range ms {
		n.members[m.UserID] = m
	}
	for _, s := range ss {
		n.statuses[s.ID] = s
	}
	for _, l := range ls {
		n.labels[l.ID] = l
	}
	for _, p := range ps {
		n.projects[p.ID] = p
	}
	for _, e := range es {
		n.epics[e.ID] = e
	}
	for _, cy := range cs {
		n.cycles[cy.ID] = cy
	}
	x.nm = n
	return n, nil
}

// handle returns "@handle" for a user id, or "" for none.
func (n *names) handle(userID string) string {
	if userID == "" {
		return ""
	}
	if m, ok := n.members[userID]; ok {
		return "@" + m.Handle
	}
	return "@unknown"
}

func (n *names) labelNames(ids []string) []string {
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
}

// fromURL fills a struct from URL parameters named like its JSON fields.
// Lists are comma-separated. Parameters in skip belong to the endpoint, and
// any other unknown one is refused with the nearest real name.
func fromURL(v url.Values, dst any, skip ...string) error {
	rv := reflect.ValueOf(dst).Elem()
	rt := rv.Type()
	fields := map[string]int{}
	var known []string
	for i := 0; i < rt.NumField(); i++ {
		name := strings.Split(rt.Field(i).Tag.Get("json"), ",")[0]
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
			var ns []int
			for _, p := range splitList(raw) {
				n, err := strconv.Atoi(p)
				if err != nil {
					return errBad("%s: %q is not a number", name, p)
				}
				ns = append(ns, n)
			}
			f.Set(reflect.ValueOf(ns))
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

func truthy(s string) bool { return s == "1" || s == "true" || s == "yes" || s == "" }

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

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
	f := store.TaskFilter{Keys: upper(q.Keys), Priorities: q.Priorities(), DueBefore: q.DueBefore, DueAfter: q.DueAfter,
		ActivityAfter: q.ChangedSince, UpdatedAfter: q.UpdatedSince, OpenDecision: q.OpenDecision, TopLevel: q.TopLevel,
		Text: q.Q, InTrash: q.Trash, Archived: q.Archived, Sort: q.Sort, Limit: q.Limit, Offset: q.Offset, Categories: q.Category}
	nm, err := x.names()
	if err != nil {
		return f, err
	}
	rs := x.resolver()
	var projects []core.Project
	for _, ref := range q.Project {
		p, err := rs.Project(ref)
		if err != nil {
			return f, err
		}
		if !x.canProject(p.ID) {
			return f, errForbidden("your access does not include project %s", p.Key)
		}
		projects = append(projects, p)
		f.ProjectIDs = append(f.ProjectIDs, p.ID)
	}
	if len(projects) == 0 {
		for _, p := range nm.projects {
			if p.DeletedAt == 0 && x.canProject(p.ID) {
				projects = append(projects, p)
			}
		}
		if x.projects != nil {
			f.ProjectIDs = x.projects
		}
	}
	for _, c := range q.Category {
		if !core.ValidCategory(c) {
			return f, &engine.Error{Code: engine.CodeInvalid, Field: "category", Message: "unknown category " + strconv.Quote(c), Allowed: core.Categories}
		}
	}
	if q.Open != nil {
		if *q.Open {
			f.Open = true
		} else {
			f.Categories = append(f.Categories, core.CatDone, core.CatCanceled)
		}
	}
	member := func(field, ref string) (string, error) {
		if ref == "" {
			return "", nil
		}
		m, err := rs.Member(field, ref)
		return m.UserID, err
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
	inScope := func(projectID string) bool {
		for _, p := range projects {
			if p.ID == projectID {
				return true
			}
		}
		return false
	}
	for _, ref := range q.Status {
		low := strings.ToLower(ref)
		var found bool
		var allowed []string
		for _, s := range nm.statuses {
			if s.DeletedAt != 0 || !inScope(s.ProjectID) {
				continue
			}
			if s.ID == ref || strings.ToLower(s.Name) == low {
				f.StatusIDs = append(f.StatusIDs, s.ID)
				found = true
			}
			if !has(allowed, s.Name) {
				allowed = append(allowed, s.Name)
			}
		}
		if !found && core.ValidCategory(low) {
			f.Categories = append(f.Categories, low)
			found = true
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
		for _, l := range nm.labels {
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
		for _, e := range nm.epics {
			if e.DeletedAt != 0 || !inScope(e.ProjectID) {
				continue
			}
			if e.ID == ref || strings.ToLower(e.Name) == low {
				f.EpicIDs = append(f.EpicIDs, e.ID)
				found = true
			}
			allowed = append(allowed, e.Name)
		}
		if !found {
			sort.Strings(allowed)
			return f, &engine.Error{Code: engine.CodeInvalid, Field: "epic", Message: "no epic " + strconv.Quote(ref), Allowed: allowed, Nearest: nearestOf(ref, allowed)}
		}
	}
	for _, ref := range q.Cycle {
		if ref == "none" {
			f.NoCycle = true
			continue
		}
		var found bool
		for _, p := range projects {
			if cy, err := rs.Cycle(p, ref); err == nil {
				f.CycleIDs = append(f.CycleIDs, cy.ID)
				found = true
			}
		}
		if !found {
			return f, errBad("no cycle %q: use current, next, a cycle number or none", ref)
		}
	}
	if q.Milestone != "" {
		f.MilestoneID = q.Milestone
	}
	if q.Parent != "" {
		t, err := rs.Task(q.Parent)
		if err != nil {
			return f, err
		}
		f.ParentID = t.ID
	}
	if _, ok := taskSorts[f.Sort]; !ok {
		return f, &engine.Error{Code: engine.CodeInvalid, Field: "sort", Message: "unknown sort " + strconv.Quote(f.Sort), Allowed: sortNames}
	}
	return f, nil
}

var sortNames = []string{"created", "-created", "rank", "priority", "due", "-activity", "-updated", "key"}
var taskSorts = map[string]bool{"": true, "created": true, "-created": true, "rank": true, "priority": true, "due": true, "-activity": true, "-updated": true, "key": true}

// Priorities returns the priority filter.
func (q TaskQuery) Priorities() []int { return q.Priority }

func upper(list []string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = strings.ToUpper(s)
	}
	return out
}

// queryFromRequest builds a TaskQuery from a saved view (when view= names
// one) overlaid with the URL's own parameters.
func (x *c) queryFromRequest(skip ...string) (TaskQuery, error) {
	var q TaskQuery
	v := x.r.URL.Query()
	if slug := v.Get("view"); slug != "" {
		var view core.View
		cond := store.Eq("slug", slug)
		if len(slug) == 36 {
			cond = store.Eq("id", slug)
		}
		if err := x.db.Get(x.ctx(), &view, cond, store.Live); err != nil || (!view.Shared && view.OwnerID != x.member.UserID) {
			var all []core.View
			x.db.List(x.ctx(), &all, store.Where(store.Live))
			var slugs []string
			for _, a := range all {
				if a.Shared || a.OwnerID == x.member.UserID {
					slugs = append(slugs, a.Slug)
				}
			}
			return q, &engine.Error{Code: engine.CodeNotFound, Field: "view", Message: "no view " + strconv.Quote(slug), Allowed: slugs, Nearest: nearestOf(slug, slugs)}
		}
		if len(view.Query) > 0 {
			if err := json.Unmarshal(view.Query, &q); err != nil {
				return q, &engine.Error{Code: engine.CodeInvalid, Field: "view", Message: fmt.Sprintf("the view %s has a filter that cannot be read (%s); save it again with view.update", view.Slug, strings.TrimPrefix(err.Error(), "json: "))}
			}
		}
		if view.ProjectID != "" && len(q.Project) == 0 {
			q.Project = []string{view.ProjectID}
		}
	}
	// A priority may be asked for by name.
	if ps := v["priority"]; len(ps) > 0 {
		var nums []string
		for _, p := range splitList(strings.Join(ps, ",")) {
			found := false
			for n, name := range engine.PriorityNames {
				if strings.EqualFold(p, name) {
					nums, found = append(nums, strconv.Itoa(n)), true
				}
			}
			if _, err := strconv.Atoi(p); err == nil {
				nums, found = append(nums, p), true
			}
			if !found {
				return q, &engine.Error{Code: engine.CodeInvalid, Field: "priority", Message: "unknown priority " + strconv.Quote(p), Allowed: engine.PriorityNames, Nearest: nearestOf(p, engine.PriorityNames)}
			}
		}
		v = cloneValues(v)
		v["priority"] = []string{strings.Join(nums, ",")}
	}
	err := fromURL(v, &q, append(skip, "view", "format", "fields", "count", "raw", "since")...)
	return q, err
}

func init() {
	// A view is saved only with a filter that task queries can read.
	engine.CheckViewQuery = func(raw json.RawMessage) error {
		var q TaskQuery
		if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&q); err != nil {
			return fmt.Errorf("this filter cannot be read (%s). It is an object of task filters; lists such as label, status and assignee are written as lists: {\"label\": [\"art\"]}", strings.TrimPrefix(err.Error(), "json: "))
		}
		return nil
	}
}

func cloneValues(v url.Values) url.Values {
	out := url.Values{}
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}
