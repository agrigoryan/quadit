// Task queries: the core.TaskQuery a request or a feed asks with, read from
// the URL (over a saved view when one is named), and the workspace's names
// for the compact forms. The engine turns a query into the store's filter
// (engine.Resolver.TaskFilter).

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"slices"
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

// names returns the workspace's names: its small tables (members, statuses,
// labels, projects, epics, cycles, milestones), every row of them, deleted
// ones too, read on the first call and kept for as long as the viewer is: a
// request, or one piece of the server's own work.
func (who *viewer) names(ctx context.Context) (*nameLookup, error) {
	if who.nameCache != nil {
		return who.nameCache, nil
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
	for _, list := range []struct {
		into  any
		order string
	}{
		{&members, ""}, {&statuses, "rank"}, {&labels, ""}, {&projects, "rank"}, {&epics, ""}, {&cycles, ""}, {&milestones, ""},
	} {
		if err := who.db.List(ctx, list.into, store.Q{Order: list.order}); err != nil {
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
	who.nameCache = lookup
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

// labelNames names labels by id, leaving out the ids of none.
func (n *nameLookup) labelNames(ids []string) []string {
	var out []string
	for _, l := range ids {
		if lb, ok := n.labels[l]; ok {
			out = append(out, lb.Name)
		}
	}
	return out
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
				Allowed: known, Nearest: engine.Nearest(name, known)}
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

// resolver finds tasks, projects, members and cycles by what the caller
// calls them, as the caller.
func (who *viewer) resolver(ctx context.Context) *engine.Resolver {
	return engine.NewResolver(ctx, who.db, who.member, time.Now().UnixMilli())
}

// taskFilter turns a task query into the store's filter as the caller,
// kept to the projects the caller may read. stale is what a saved view
// names that is gone, in words for the caller, when the list was read
// without that part.
func (who *viewer) taskFilter(ctx context.Context, q core.TaskQuery) (f store.TaskFilter, stale string, err error) {
	return who.resolver(ctx).TaskFilter(q, who.projects)
}

// idLength is the length of an id (a UUID): a reference that long is taken
// as an id, any other as a name.
const idLength = 36

// savedView finds a saved view the viewer may see, by id, by slug, or by its
// name as the sidebar shows it. One that is not there, or not the viewer's
// to see, is answered with the views that are.
func (who *viewer) savedView(ctx context.Context, ref string) (core.View, error) {
	var views []core.View
	if err := who.db.List(ctx, &views, store.Where(store.Live)); err != nil {
		return core.View{}, err
	}
	views = keep(views, who.canSeeView)
	for _, match := range []func(core.View) bool{
		func(view core.View) bool { return len(ref) == idLength && view.ID == ref },
		func(view core.View) bool { return len(ref) != idLength && view.Slug == ref },
		func(view core.View) bool { return strings.EqualFold(view.Name, ref) },
	} {
		if i := slices.IndexFunc(views, match); i >= 0 {
			return views[i], nil
		}
	}
	slugs := make([]string, len(views))
	for i, view := range views {
		slugs[i] = view.Slug
	}
	return core.View{}, &engine.Error{Code: engine.CodeNotFound, Field: "view", Message: "no view " + strconv.Quote(ref), Allowed: slugs, Nearest: engine.Nearest(ref, slugs)}
}

// queryFromRequest builds a task query from a saved view (when view= names
// one the caller may see) overlaid with the URL's own parameters. skip
// names the endpoint's own parameters, which are not task filters. since=
// is read as changed_since=, and a priority may be given by name.
func (x *c) queryFromRequest(skip ...string) (core.TaskQuery, error) {
	var q core.TaskQuery
	v := x.r.URL.Query()
	if ref := v.Get("view"); ref != "" {
		// The saved view: its filter is the base the URL adds to.
		view, err := x.savedView(x.ctx(), ref)
		if err != nil {
			return q, err
		}
		if len(view.Query) > 0 {
			if err := json.Unmarshal(view.Query, &q); err != nil {
				return q, &engine.Error{Code: engine.CodeInvalid, Field: "view", Message: fmt.Sprintf("the view %s has a filter that cannot be read (%s); save it again with view.update", view.Slug, engine.PlainJSON(err))}
			}
		}
		if view.ProjectID != "" && len(q.Project) == 0 {
			q.Project = []string{view.ProjectID}
		}
		q.SavedAs = view.Slug
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
				return q, &engine.Error{Code: engine.CodeInvalid, Field: "priority", Message: "unknown priority " + strconv.Quote(priority), Allowed: engine.PriorityNames, Nearest: engine.Nearest(priority, engine.PriorityNames)}
			}
		}
		v = cloneValues(v)
		v["priority"] = []string{strings.Join(nums, ",")}
	}
	err := fromURL(v, &q, append(skip, "view", "format", "fields", "count", "raw", "since", "cursor")...)
	return q, err
}

// cloneValues copies URL parameters, so they can be changed.
func cloneValues(v url.Values) url.Values {
	out := url.Values{}
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}
