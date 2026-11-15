// Making the plan's tasks: each with its place, comments, files and
// watchers, and then the relations between them.

package importer

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
)

// makeTasks makes every task of the plan, each after the one it is under,
// and notes the assignees who have no member here.
func (a *applier) makeTasks() error {
	a.tasks, a.taskDone, a.unmatched = map[string]Task{}, map[string]bool{}, map[string]bool{}
	for _, t := range a.plan.Tasks {
		a.tasks[t.Ext] = t
	}
	for _, t := range a.plan.Tasks {
		if err := a.makeTask(t, 0); err != nil {
			return err
		}
		if a.sum.Tasks > 0 && a.sum.Tasks%100 == 0 {
			a.sink.Logf("%d tasks…", a.sum.Tasks)
		}
	}
	for who := range a.unmatched {
		a.sum.Unmatched = append(a.sum.Unmatched, who)
	}
	sort.Strings(a.sum.Unmatched)
	return nil
}

// makeTask makes one task, after the task it is under, with its comments
// and files.
func (a *applier) makeTask(t Task, depth int) error {
	if a.taskDone[t.Ext] {
		return nil
	}
	a.taskDone[t.Ext] = true
	key := a.keyOf(t.Project)
	args := map[string]any{"id": a.uid("task", t.Ext), "project": a.projectID[key], "title": orStr(strings.TrimSpace(t.Title), "Untitled"), "priority": t.Priority}
	if parent, ok := a.tasks[t.ParentExt]; ok && t.ParentExt != "" && depth < 20 {
		if err := a.makeTask(parent, depth+1); err != nil {
			return err
		}
		args["parent"] = a.uid("task", parent.Ext)
	}
	if err := a.place(t, key, args); err != nil {
		return err
	}
	var notes []string
	if t.Assignee != "" {
		if m := a.member(t.Assignee); m != "" {
			args["assignee"] = m
		} else {
			a.unmatched[t.Assignee] = true
			notes = append(notes, "Assigned there to "+t.Assignee+".")
		}
	}
	if len(t.DueOn) >= 10 {
		args["due_on"] = t.DueOn[:10]
	}
	if t.Estimate > 0 {
		args["estimate"] = t.Estimate
	}
	if err := a.createTask(t, key, args, notes); err != nil {
		return fmt.Errorf("task %q: %w", t.Title, err)
	}
	if a.fresh {
		a.sum.Tasks++
	}
	if err := a.attach(t.Files, "task", a.uid("task", t.Ext), t.Ext); err != nil {
		return err
	}
	return a.makeComments(t)
}

// place gives a task its status, labels and epic, making the ones that are
// not here yet.
func (a *applier) place(t Task, key string, args map[string]any) error {
	// A status keeps its name; one that is new here is made in the right
	// category.
	if t.Status != "" {
		if err := a.makeStatus(key, t.Status, t.Category, ""); err != nil {
			return err
		}
		args["status"] = t.Status
	} else if t.Category != "" {
		args["status"] = t.Category
	}
	var names []string
	for _, l := range t.Labels {
		if l = strings.TrimSpace(l); l == "" {
			continue
		}
		if err := a.makeLabel(key, l, ""); err != nil {
			return err
		}
		names = append(names, l)
	}
	if len(names) > 0 {
		args["labels"] = names
	}
	if t.Epic != "" {
		if !a.has(a.epics, key, t.Epic) {
			if err := a.change("epic.create", map[string]any{"id": a.uid("epic", key+"/"+strings.ToLower(t.Epic)), "project": a.projectID[key], "name": t.Epic}); err != nil {
				return fmt.Errorf("epic %q: %w", t.Epic, err)
			}
			a.epics = append(a.epics, row{Name: t.Epic, ProjectID: a.projectID[key]})
		}
		args["epic"] = t.Epic
	}
	return nil
}

// createTask sends the task. It asks for the number the task had at the
// source; if someone here has that number already, it gets the next one.
func (a *applier) createTask(t Task, key string, args map[string]any, notes []string) error {
	keyHere := ""
	if t.Number > 0 {
		keyHere = fmt.Sprintf("%s-%d", key, t.Number)
		args["number"] = t.Number
	}
	args["description"] = a.describe(t, notes, keyHere)
	err := a.change("task.create", args)
	if t.Number > 0 && refusedFor(err, refusalNumberTaken) {
		delete(args, "number")
		args["description"] = a.describe(t, notes, "")
		err = a.change("task.create", args)
	}
	return err
}

// describe is the task's description here: its text, with files pointing
// at their copies, and a line under it saying where it came from. What it
// was called there is said only when it is called something else here:
// keyHere is the key it asks for here, empty when it gets the next one.
func (a *applier) describe(t Task, notes []string, keyHere string) string {
	notes = slices.Clip(notes)
	if t.WasKey != "" && !strings.EqualFold(t.WasKey, keyHere) {
		notes = append(notes, "Was "+t.WasKey+" there.")
	}
	if t.URL != "" {
		notes = append(notes, "Imported from "+t.URL)
	} else if t.Ext != "" {
		notes = append(notes, "Imported from "+a.plan.Source+" "+t.Ext+".")
	}
	desc := a.here(t.Description)
	if len(notes) == 0 {
		return desc
	}
	return strings.TrimSpace(desc + "\n\n" + strings.Join(notes, " "))
}

// makeComments brings a task's comments. They are written by the one
// running the import, so each says who wrote it there, and when; a writer
// who is a member here follows the task, as if they had written it here.
func (a *applier) makeComments(t Task) error {
	watching := map[string]bool{}
	for i, cm := range t.Comments {
		if strings.TrimSpace(cm.Body) == "" && len(cm.Files) == 0 {
			continue
		}
		was := fmt.Sprintf("%s/%d", t.Ext, i)
		body := a.here(cm.Body)
		if cm.Author != "" {
			head := "**" + cm.Author + "**"
			if cm.At != "" {
				head += ", " + cm.At[:min(len(cm.At), 10)]
			}
			body = head + ":\n\n" + body
		}
		if err := a.change("comment.create", map[string]any{"id": a.uid("comment", was), "task": a.uid("task", t.Ext), "body": body}); err != nil {
			return fmt.Errorf("comment on %q: %w", t.Title, err)
		}
		if a.fresh {
			a.sum.Comments++
		}
		if err := a.attach(cm.Files, "comment", a.uid("comment", was), was); err != nil {
			return err
		}
		if m := a.member(cm.Author); m != "" && !watching[m] {
			watching[m] = true
			if err := a.follow(t, m); err != nil {
				return err
			}
		}
	}
	return nil
}

// follow makes a member a watcher of an imported task. It is not counted
// in what the import made.
func (a *applier) follow(t Task, userID string) error {
	task := a.uid("task", t.Ext)
	err := a.sink.Change(id.From("import-change", a.plan.Source, "watch.set", task, userID), "watch.set", map[string]any{"subject": task, "user": userID})
	if err != nil {
		return fmt.Errorf("watcher of %q: %w", t.Title, err)
	}
	return nil
}

// member finds the member here that a name or an email address from the
// source means: by address, by name, by handle, and last by a first name
// alone ("Ann" for Ann Lee) when only one member has it.
func (a *applier) member(who string) string {
	w := strings.ToLower(strings.TrimSpace(who))
	if w == "" {
		return ""
	}
	local, _, _ := strings.Cut(w, "@")
	for _, m := range a.members {
		name := strings.ToLower(m.Name)
		if strings.ToLower(m.Email) == w || name == w || m.Handle == w || m.Handle == local || name == strings.ReplaceAll(local, ".", " ") {
			return m.UserID
		}
	}
	if strings.Contains(w, "@") {
		return ""
	}
	found := ""
	for _, m := range a.members {
		if strings.HasPrefix(strings.ToLower(m.Name), w+" ") || strings.HasPrefix(m.Handle, w+"-") {
			if found != "" && found != m.UserID {
				return ""
			}
			found = m.UserID
		}
	}
	return found
}

// relateTasks says how the tasks hang together, once they are all there.
func (a *applier) relateTasks() error {
	for _, t := range a.plan.Tasks {
		for typ, others := range map[string][]string{core.RelBlocks: t.Blocks, core.RelRelates: t.Relates} {
			for _, o := range others {
				if _, ok := a.tasks[o]; !ok {
					continue
				}
				if err := a.change("relation.add", map[string]any{"id": a.uid("relation", t.Ext+"/"+typ+"/"+o), "task": a.uid("task", t.Ext), "other": a.uid("task", o), "type": typ}); err != nil {
					return fmt.Errorf("relation of %q: %w", t.Title, err)
				}
			}
		}
	}
	return nil
}
