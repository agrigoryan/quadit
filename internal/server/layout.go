// A project's layout (/projects/KEY/layout): what it has, by name.

package server

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowProjectLayout describes one project: its statuses, labels, members, epics,
// cycles and templates, by name, and the estimates it takes.
func (s *Server) handleShowProjectLayout(x *c) error {
	project, err := x.resolver(x.ctx()).Project(x.r.PathValue("key"))
	if err != nil {
		return err
	}
	if !x.canProject(project.ID) {
		return errNotFound("project " + project.Key)
	}
	out, err := x.layout(x.ctx(), project)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(layoutText(project, out))
	}
	about := map[string]any{"key": project.Key, "name": project.Name, "description": project.Description}
	if estimates := layoutEstimatesOf(project.Settings); estimates != nil {
		about["estimates"] = estimates
	}
	return x.ok(map[string]any{"project": about, "layout": out})
}

// layoutEstimates is what a project takes as an estimate, so an agent can
// send one without being refused first: the scale, its values in points (0
// among them where allowed; none on points, which takes any whole number),
// its sizes on the T-shirt scale (which the API takes as well as the
// numbers), all of it in words, and what a 0 sent does: true, it is an
// estimate of its own; false, it clears the estimate.
type layoutEstimates struct {
	Scale  string   `json:"scale"`
	Values []int    `json:"values,omitempty"`
	Sizes  []string `json:"sizes,omitempty"`
	Words  string   `json:"words"`
	Zero   bool     `json:"zero"`
}

// layoutEstimatesOf is a project's layoutEstimates; nil when it does not
// estimate.
func layoutEstimatesOf(s *core.ProjectSettings) *layoutEstimates {
	if !s.Estimating() {
		return nil
	}
	out := &layoutEstimates{Scale: s.Scale(), Values: s.EstimateValues(), Words: s.EstimateWords(), Zero: s.ZeroEstimates()}
	if out.Scale == core.ScaleTShirt {
		for _, n := range out.Values {
			if n > 0 { // 0 is a number of points, not a size
				out.Sizes = append(out.Sizes, s.EstimateName(n))
			}
		}
	}
	return out
}

// layoutItem is one thing a project has, by name, with what its kind of
// thing says about it.
type layoutItem struct {
	Name     string `json:"name"`
	Category string `json:"category,omitempty"`
	Default  bool   `json:"default,omitempty"`
	State    string `json:"state,omitempty"`
	Role     string `json:"role,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Dates    string `json:"dates,omitempty"`
	Title    string `json:"title,omitempty"`
}

// layout gathers what a project has: its statuses in their own order, the
// other lists by name. A list the project has nothing in is left out.
func (who *viewer) layout(ctx context.Context, project core.Project) (map[string][]layoutItem, error) {
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	var templates []core.Template
	if err := who.db.List(ctx, &templates, store.Where(store.Live)); err != nil {
		return nil, err
	}
	out := map[string][]layoutItem{
		"statuses":  layoutStatuses(names, project.ID),
		"labels":    layoutLabels(names, project.ID),
		"members":   layoutMembers(names),
		"epics":     layoutEpics(names, project.ID),
		"cycles":    layoutCycles(names, project.ID),
		"templates": layoutTemplates(templates, project.ID),
	}
	for k, list := range out {
		if len(list) == 0 {
			delete(out, k)
			continue
		}
		if k != "statuses" {
			sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		}
	}
	return out, nil
}

// layoutStatuses lists the project's statuses in the order it ranks them.
func layoutStatuses(names *nameLookup, projectID string) []layoutItem {
	var statuses []core.Status
	for _, status := range names.statuses {
		if status.ProjectID == projectID && status.DeletedAt == 0 {
			statuses = append(statuses, status)
		}
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].Rank < statuses[j].Rank })
	var out []layoutItem
	for _, status := range statuses {
		out = append(out, layoutItem{Name: status.Name, Category: status.Category, Default: status.IsDefault})
	}
	return out
}

// layoutLabels lists the project's labels and the workspace's.
func layoutLabels(names *nameLookup, projectID string) []layoutItem {
	var out []layoutItem
	for _, label := range names.labels {
		if (label.ProjectID == "" || label.ProjectID == projectID) && label.DeletedAt == 0 {
			out = append(out, layoutItem{Name: label.Name})
		}
	}
	return out
}

// layoutMembers lists the workspace's members: every project has them all.
func layoutMembers(names *nameLookup) []layoutItem {
	var out []layoutItem
	for _, member := range names.members {
		if member.RemovedAt == 0 {
			out = append(out, layoutItem{Name: "@" + member.Handle, Role: string(member.Role), Kind: member.Kind, Title: member.Name})
		}
	}
	return out
}

// layoutEpics lists the project's epics with their state and target date.
func layoutEpics(names *nameLookup, projectID string) []layoutItem {
	var out []layoutItem
	for _, epic := range names.epics {
		if epic.ProjectID == projectID && epic.DeletedAt == 0 {
			out = append(out, layoutItem{Name: epic.Name, State: epic.State, Dates: epic.TargetOn})
		}
	}
	return out
}

// layoutCycles lists the project's cycles that have not ended, by number.
func layoutCycles(names *nameLookup, projectID string) []layoutItem {
	today := time.Now().UTC().Format("2006-01-02")
	var out []layoutItem
	for _, cycle := range names.cycles {
		if cycle.ProjectID == projectID && cycle.DeletedAt == 0 && cycle.EndsOn >= today {
			out = append(out, layoutItem{Name: fmt.Sprint(cycle.Number), Dates: cycle.StartsOn + " to " + cycle.EndsOn})
		}
	}
	return out
}

// layoutTemplates lists the project's templates and the workspace's.
func layoutTemplates(templates []core.Template, projectID string) []layoutItem {
	var out []layoutItem
	for _, template := range templates {
		if template.ProjectID == "" || template.ProjectID == projectID {
			out = append(out, layoutItem{Name: template.Name})
		}
	}
	return out
}

// layoutText is a layout as lines of text, one list on each.
func layoutText(project core.Project, out map[string][]layoutItem) string {
	var b strings.Builder
	fmt.Fprintf(&b, "project %s  %s\n", project.Key, project.Name)
	if estimates := layoutEstimatesOf(project.Settings); estimates != nil {
		zero := "0 clears an estimate"
		if estimates.Zero {
			zero = "0 is an estimate of its own"
		}
		fmt.Fprintf(&b, "estimates: %s (%s scale); %s\n", estimates.Words, estimates.Scale, zero)
	}
	for _, k := range []string{"statuses", "labels", "members", "epics", "cycles", "templates"} {
		var parts []string
		for _, item := range out[k] {
			part := item.Name
			if item.Category != "" {
				part += " (" + item.Category + ")"
			}
			if item.Kind == core.KindAgent {
				part += " (agent)"
			}
			if item.Dates != "" {
				part += " (" + item.Dates + ")"
			}
			parts = append(parts, part)
		}
		if len(parts) > 0 {
			fmt.Fprintf(&b, "%s: %s\n", k, strings.Join(parts, ", "))
		}
	}
	return b.String()
}
