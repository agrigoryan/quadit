package server

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowProjectLayout describes one project: its statuses, labels, members, epics,
// cycles and templates, by name.
func (s *Server) handleShowProjectLayout(x *c) error {
	project, err := x.resolver().Project(x.r.PathValue("key"))
	if err != nil {
		return err
	}
	if !x.canProject(project.ID) {
		return errNotFound("project " + project.Key)
	}
	out, err := x.layout(project)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(layoutText(project, out))
	}
	return x.ok(map[string]any{"project": map[string]string{"key": project.Key, "name": project.Name, "description": project.Description}, "layout": out})
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
func (x *c) layout(project core.Project) (map[string][]layoutItem, error) {
	names, err := x.names()
	if err != nil {
		return nil, err
	}
	var templates []core.Template
	if err := x.db.List(x.ctx(), &templates, store.Where(store.Live)); err != nil {
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
