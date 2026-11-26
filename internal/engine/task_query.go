// Turning a task query into the store's filter, every name resolved.

package engine

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// TaskFilter turns a task query into the store's filter for the resolver's
// member: every name becomes an id, and the tasks are kept to the projects
// the member may read. readable lists those projects; nil lets in every
// one.
//
// A name that finds nothing is refused, with the names allowed and the
// nearest one. The exception is a query read from a saved view (q.SavedAs):
// a status, label or epic deleted since the view was saved is left out, and
// stale says so in words for whoever opened the view; it is "" otherwise.
//
// The same reading is made when a view is saved and when it is opened, when
// a list is asked by URL and when the feed is narrowed to some tasks: this
// is the one place that knows what each part of a query means.
func (r *Resolver) TaskFilter(q core.TaskQuery, readable []string) (f store.TaskFilter, stale string, err error) {
	f = store.TaskFilter{Keys: upperAll(q.Keys), Priorities: q.Priority, DueBefore: q.DueBefore, DueAfter: q.DueAfter,
		ActivityAfter: q.ChangedSince, UpdatedAfter: q.UpdatedSince, OpenDecision: q.OpenDecision, TopLevel: q.TopLevel,
		Text: q.Q, InTrash: q.Trash, Archived: q.Archived, Sort: q.Sort, Limit: q.Limit, Offset: q.Offset, Categories: q.Category}
	mayRead := func(projectID string) bool { return readable == nil || slices.Contains(readable, projectID) }
	// gone notes the first thing a saved view names that is no longer there.
	gone := func(what string) {
		if stale == "" {
			stale = fmt.Sprintf("the view %s filters by %s that no longer exists; that part was left out. Save the view again (view.update) to drop it", q.SavedAs, what)
		}
	}

	// The projects asked for, or every one the member may read. They bound
	// every other name: a status, a label, an epic or a cycle is one of theirs.
	var projects []core.Project
	for _, ref := range q.Project {
		project, err := r.project(ref)
		if err != nil {
			return f, "", err
		}
		if !mayRead(project.ID) {
			return f, "", forbidden("your access does not include project %s", project.Key)
		}
		projects = append(projects, project)
		f.ProjectIDs = append(f.ProjectIDs, project.ID)
	}
	if len(projects) == 0 {
		var all []core.Project
		if err := r.db.List(r.ctx, &all, store.Where(store.Live)); err != nil {
			return f, "", err
		}
		for _, project := range all {
			if mayRead(project.ID) {
				projects = append(projects, project)
			}
		}
		if readable != nil {
			f.ProjectIDs = readable
		}
	}
	inScope := func(projectID string) bool {
		return slices.ContainsFunc(projects, func(project core.Project) bool { return project.ID == projectID })
	}

	for _, category := range q.Category {
		if !core.ValidCategory(category) {
			return f, "", &Error{Code: CodeInvalid, Field: "category", Message: "unknown category " + strconv.Quote(category), Allowed: core.Categories}
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
	for _, ref := range q.Assignee {
		if ref == "none" {
			f.Unassigned = true
			continue
		}
		userID, err := r.optMember("assignee", ref)
		if err != nil {
			return f, "", err
		}
		f.AssigneeIDs = append(f.AssigneeIDs, userID)
	}
	switch strings.ToLower(q.WaitingOn) {
	case "outside", "external", "event":
		f.WaitingOutside, q.WaitingOn = true, ""
	case "none", "nobody":
		f.WaitingNobody, q.WaitingOn = true, ""
	}
	for _, m := range []struct {
		field, ref string
		into       *string
	}{
		{"creator", q.Creator, &f.CreatedBy}, {"waiting_on", q.WaitingOn, &f.WaitingOnID}, {"held_by", q.HeldBy, &f.LeaseHolderID},
		{"mentions", q.Mentions, &f.MentionsID}, {"asked", q.Asked, &f.AskedID},
	} {
		if *m.into, err = r.optMember(m.field, m.ref); err != nil {
			return f, "", err
		}
	}
	if q.Watching {
		f.WatchedBy = r.actor.UserID
	}

	// Statuses, labels and epics by name, among those of the projects. A
	// status may also be a category; a label may be the workspace's.
	if len(q.Status) > 0 {
		var statuses []core.Status
		if err := r.db.List(r.ctx, &statuses, store.Where(store.Live)); err != nil {
			return f, "", err
		}
		for _, ref := range q.Status {
			low := strings.ToLower(ref)
			var found bool
			var allowed []string
			for _, status := range statuses {
				if !inScope(status.ProjectID) {
					continue
				}
				if status.ID == ref || strings.ToLower(status.Name) == low {
					f.StatusIDs = append(f.StatusIDs, status.ID)
					found = true
				}
				if !slices.Contains(allowed, status.Name) {
					allowed = append(allowed, status.Name)
				}
			}
			if !found && core.ValidCategory(low) {
				f.Categories = append(f.Categories, low)
				found = true
			}
			if !found && q.SavedAs != "" {
				gone("a status")
				continue
			}
			if !found {
				sort.Strings(allowed)
				return f, "", &Error{Code: CodeInvalid, Field: "status", Message: "no status " + strconv.Quote(ref),
					Allowed: append(allowed, core.Categories...), Nearest: nearest(ref, allowed)}
			}
		}
	}
	if len(q.Label) > 0 {
		var labels []core.Label
		if err := r.db.List(r.ctx, &labels, store.Where(store.Live)); err != nil {
			return f, "", err
		}
		for _, ref := range q.Label {
			low := strings.ToLower(ref)
			var ids, allowed []string
			for _, label := range labels {
				if label.ProjectID != "" && !inScope(label.ProjectID) {
					continue
				}
				if label.ID == ref || strings.ToLower(label.Name) == low {
					ids = append(ids, label.ID)
				}
				allowed = append(allowed, label.Name)
			}
			switch len(ids) {
			case 1:
				f.LabelIDs = append(f.LabelIDs, ids[0])
			case 0:
				if q.SavedAs != "" {
					gone("a label")
					continue
				}
				sort.Strings(allowed)
				return f, "", &Error{Code: CodeInvalid, Field: "label", Message: "no label " + strconv.Quote(ref), Allowed: allowed, Nearest: nearest(ref, allowed)}
			default:
				return f, "", &Error{Code: CodeInvalid, Message: fmt.Sprintf("several projects have a label %q: add project=KEY", ref)}
			}
		}
	}
	if len(q.Epic) > 0 {
		var epics []core.Epic
		if err := r.db.List(r.ctx, &epics, store.Where(store.Live)); err != nil {
			return f, "", err
		}
		for _, ref := range q.Epic {
			if ref == "none" {
				f.NoEpic = true
				continue
			}
			low := strings.ToLower(ref)
			var found bool
			var allowed []string
			for _, epic := range epics {
				if !inScope(epic.ProjectID) {
					continue
				}
				if epic.ID == ref || strings.ToLower(epic.Name) == low {
					f.EpicIDs = append(f.EpicIDs, epic.ID)
					found = true
				}
				allowed = append(allowed, epic.Name)
			}
			if !found && q.SavedAs != "" {
				gone("an epic")
				continue
			}
			if !found {
				sort.Strings(allowed)
				return f, "", &Error{Code: CodeInvalid, Field: "epic", Message: "no epic " + strconv.Quote(ref), Allowed: allowed, Nearest: nearest(ref, allowed)}
			}
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
			cycle, err := r.cycle(project, "cycle", ref)
			if err != nil && !isRefusal(err) {
				return f, "", err
			}
			if err == nil {
				f.CycleIDs = append(f.CycleIDs, cycle.ID)
				found = true
			}
		}
		if !found && (ref == "current" || ref == "next") {
			// No cycle is running (or none comes next): nothing is in it.
			f.CycleIDs = append(f.CycleIDs, "no-such-cycle")
			continue
		}
		if !found {
			return f, "", &Error{Code: CodeInvalid, Message: fmt.Sprintf("no cycle %q: use current, next, a cycle number or none", ref)}
		}
	}
	// Estimates, by number or by T-shirt size, or none.
	for _, ref := range q.Estimate {
		if strings.EqualFold(ref, "none") {
			f.NoEstimate = true
			continue
		}
		n, ok := core.EstimatePoints(ref)
		if !ok {
			allowed := append([]string{"none"}, core.TShirtSizes...)
			return f, "", &Error{Code: CodeInvalid, Field: "estimate", Message: "unknown estimate " + strconv.Quote(ref) + ": ask for a number of points, a T-shirt size or none",
				Allowed: allowed, Nearest: nearest(ref, allowed)}
		}
		f.Estimates = append(f.Estimates, n)
	}
	if q.Milestone != "" {
		// By id (anything as long as one), or by name.
		f.MilestoneID = q.Milestone
		if len(q.Milestone) != idLength {
			var milestones []core.Milestone
			if err := r.db.List(r.ctx, &milestones, store.Where(store.Live)); err != nil {
				return f, "", err
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
				return f, "", &Error{Code: CodeNotFound, Field: "milestone", Message: "no milestone " + strconv.Quote(q.Milestone), Allowed: allowed, Nearest: nearest(q.Milestone, allowed)}
			}
		}
	}
	if q.Parent != "" {
		parent, err := r.anyTask("task", q.Parent)
		if err != nil {
			return f, "", err
		}
		f.ParentID = parent.ID
	}
	if _, ok := store.TaskSortKeys[f.Sort]; !ok {
		return f, "", &Error{Code: CodeInvalid, Field: "sort", Message: "unknown sort " + strconv.Quote(f.Sort), Allowed: taskSorts}
	}
	return f, stale, nil
}

// taskSorts are the sorts a task query may ask for.
var taskSorts = []string{"created", "-created", "rank", "priority", "due", "-activity", "-updated", "key"}

// idLength is the length of an id: a milestone given by that many
// characters is taken as an id, any other as a name.
const idLength = 36

// upperAll is the list in upper case: task keys are matched that way.
func upperAll(list []string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = strings.ToUpper(s)
	}
	return out
}
