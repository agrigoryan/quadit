// Making the projects, statuses, labels and epics the tasks go in.

package importer

import (
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
)

// makeProjects makes the projects the plan names, and the ones its tasks
// go in, unless they are there.
func (a *applier) makeProjects() error {
	want := append([]Project(nil), a.plan.Projects...)
	named := map[string]bool{}
	for _, p := range want {
		named[strings.ToUpper(p.Key)] = true
	}
	for _, t := range a.plan.Tasks {
		key := a.keyOf(t.Project)
		if key == "" {
			return fmt.Errorf("say which project the tasks go in: project=KEY")
		}
		if !named[key] {
			named[key] = true
			want = append(want, Project{Key: key, Name: key})
		}
	}
	for _, p := range want {
		key := strings.ToUpper(p.Key)
		if a.projectID[key] != "" {
			continue
		}
		pid := a.uid("project", key)
		made, err := a.change("project.create", map[string]any{"id": pid, "key": key, "name": orStr(p.Name, key)})
		if err != nil {
			return fmt.Errorf("project %s: %w", key, err)
		}
		a.projectID[key] = pid
		a.madeProject[key] = made
		a.sink.Logf("made project %s", key)
	}
	return nil
}

// loadLayout reads what the workspace has that tasks are matched against.
func (a *applier) loadLayout() error {
	var err error
	for name, into := range map[string]*[]row{"statuses": &a.statuses, "labels": &a.labels, "epics": &a.epics, "members": &a.members} {
		if *into, err = a.list(name); err != nil {
			return err
		}
	}
	return nil
}

// makeWorkflow brings the statuses and labels as they were there, used by
// a task or not. A project that this import made gets exactly the source's
// workflow: the statuses a new project starts with that the source does
// not have are removed, and the order is the source's.
func (a *applier) makeWorkflow() error {
	for _, st := range a.plan.Statuses {
		key := a.keyOf(st.Project)
		if st.Name == "" || a.projectID[key] == "" {
			continue
		}
		if err := a.makeStatus(key, st.Name, st.Category, st.Color); err != nil {
			return err
		}
	}
	for _, l := range a.plan.Labels {
		key := a.keyOf(l.Project)
		if l.Name == "" || a.projectID[key] == "" {
			continue
		}
		if err := a.makeLabel(key, l.Name, l.Color); err != nil {
			return err
		}
	}
	for key, made := range a.madeProject {
		if made {
			if err := a.settleWorkflow(key); err != nil {
				return err
			}
		}
	}
	return nil
}

// makeStatus makes a status in a project unless one of that name is there.
func (a *applier) makeStatus(key, name, category, color string) error {
	if a.has(a.statuses, key, name) {
		return nil
	}
	args := map[string]any{"id": a.uid("status", key+"/"+strings.ToLower(name)), "project": a.projectID[key], "name": name, "category": orStr(category, core.CatUnstarted)}
	if color != "" {
		args["color"] = color
	}
	if _, err := a.change("status.create", args); err != nil {
		return fmt.Errorf("status %q: %w", name, err)
	}
	a.statuses = append(a.statuses, row{Name: name, ProjectID: a.projectID[key]})
	return nil
}

// makeLabel makes a label in a project unless one of that name is there.
func (a *applier) makeLabel(key, name, color string) error {
	if a.has(a.labels, key, name) {
		return nil
	}
	args := map[string]any{"id": a.uid("label", key+"/"+strings.ToLower(name)), "project": a.projectID[key], "name": name}
	if color != "" {
		args["color"] = color
	}
	if _, err := a.change("label.create", args); err != nil {
		return fmt.Errorf("label %q: %w", name, err)
	}
	a.labels = append(a.labels, row{Name: name, ProjectID: a.projectID[key]})
	return nil
}

// settleWorkflow makes a new project's statuses exactly the plan's, in the
// plan's order. It does nothing for a project whose statuses the plan does
// not list.
func (a *applier) settleWorkflow(key string) error {
	var names []string // in lower case, in the source's order
	firstOpen := ""
	for _, st := range a.plan.Statuses {
		if a.keyOf(st.Project) != key || st.Name == "" {
			continue
		}
		names = append(names, strings.ToLower(st.Name))
		if st.Category == core.CatUnstarted && firstOpen == "" {
			firstOpen = strings.ToLower(st.Name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	all, err := a.list("statuses")
	if err != nil {
		return err
	}
	here := map[string]row{} // the project's statuses by name in lower case
	for _, s := range all {
		if s.ProjectID == a.projectID[key] {
			here[strings.ToLower(s.Name)] = s
		}
	}
	if err := a.dropStarterStatuses(here, names, orStr(firstOpen, names[0])); err != nil {
		return err
	}
	at := ""
	for _, n := range names {
		at = rank.Between(at, "")
		if _, err := a.change("status.update", map[string]any{"id": here[n].ID, "rank": at}); err != nil {
			return fmt.Errorf("status %q: %w", here[n].Name, err)
		}
	}
	a.statuses, err = a.list("statuses")
	return err
}

// dropStarterStatuses removes the statuses a new project started with that
// are not among names. New tasks need a status to start in: if that one is
// going, the status called takeOver becomes it first.
func (a *applier) dropStarterStatuses(here map[string]row, names []string, takeOver string) error {
	wanted := map[string]bool{}
	for _, n := range names {
		wanted[n] = true
	}
	for n, s := range here {
		if wanted[n] {
			continue
		}
		if s.IsDefault {
			if _, err := a.change("status.update", map[string]any{"id": here[takeOver].ID, "is_default": true}); err != nil {
				return fmt.Errorf("status %q: %w", here[takeOver].Name, err)
			}
		}
		if _, err := a.change("status.delete", map[string]any{"id": s.ID}); err != nil {
			return fmt.Errorf("status %q: %w", s.Name, err)
		}
		delete(here, n)
	}
	return nil
}
