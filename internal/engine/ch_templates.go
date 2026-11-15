// template.create, template.update and template.delete.

package engine

import (
	"encoding/json"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("template.create", core.RoleMember, templateCreate)
	register("template.update", core.RoleMember, templateUpdate)
	register("template.delete", core.RoleMember, templateDelete)
}

// Preset is what a template fills in on a new task.
type Preset struct {
	Status   string   `json:"status,omitempty"`
	Priority int      `json:"priority,omitempty"`
	Labels   []string `json:"labels,omitempty"`
	Assignee string   `json:"assignee,omitempty"`
	Estimate int      `json:"estimate,omitempty"`
	// Decision, when set, is opened on the new task: a review template
	// starts with its question and options.
	Decision *decisionOpenArgs `json:"decision,omitempty"`
}

type templateCreateArgs struct {
	ID          string  `json:"id"`
	Project     string  `json:"project"`
	Name        string  `json:"name"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Preset      *Preset `json:"preset"`
}

// templateCreate keeps a template for new tasks.
func templateCreate(c *cx, a templateCreateArgs) error {
	tid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a template needs a name")
	}
	tp := core.Template{ID: tid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Title: a.Title, Description: a.Description, CreatedAt: c.at}
	if a.Preset != nil {
		tp.Preset, _ = json.Marshal(a.Preset)
	}
	if a.Project != "" {
		project, err := c.project(a.Project)
		if err != nil {
			return err
		}
		tp.ProjectID = project.ID
	}
	seq := c.tx.NextSeq()
	tp.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, tp); err != nil {
		return alreadyInUse(err, "id", tid)
	}
	return c.created(seq, "template", tp.ID, c.inProjectOrWorkspace(tp.ProjectID), tp)
}

type templateUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Title       Opt[string] `json:"title"`
	Description Opt[string] `json:"description"`
	Preset      Opt[Preset] `json:"preset"`
}

// templateUpdate changes what is given of a template; a preset sent as
// null clears it.
func templateUpdate(c *cx, a templateUpdateArgs) error {
	tp, err := loadLive[core.Template](c, "template", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &tp.Name); err != nil {
		return err
	}
	p.setText("title", a.Title, &tp.Title)
	p.setText("description", a.Description, &tp.Description)
	if a.Preset.Set {
		raw, _ := json.Marshal(a.Preset.V)
		if a.Preset.Null {
			raw = nil
		}
		if string(raw) != string(tp.Preset) {
			p.set["preset"] = json.RawMessage(raw)
			p.changes["preset"] = core.FieldChange{From: tp.Preset, To: json.RawMessage(raw)}
		}
	}
	return c.save(p, target{table: "templates", entity: "template", id: tp.ID, place: c.inProjectOrWorkspace(tp.ProjectID)})
}

func templateDelete(c *cx, a idArgs) error {
	tp, err := loadLive[core.Template](c, "template", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash(target{table: "templates", entity: "template", id: tp.ID, place: c.inProjectOrWorkspace(tp.ProjectID)})
}

// loadTemplate loads a template usable in the project by id or name.
func (c *cx) loadTemplate(project core.Project, ref string) (core.Template, error) {
	var all []core.Template
	if err := c.tx.List(c.ctx, &all, store.Q{Where: []store.Cond{store.Live}, Order: "name"}); err != nil {
		return core.Template{}, err
	}
	var names []string
	for _, t := range all {
		if t.ProjectID != "" && t.ProjectID != project.ID {
			continue
		}
		if t.ID == ref || strings.EqualFold(t.Name, ref) {
			return t, nil
		}
		names = append(names, t.Name)
	}
	return core.Template{}, &Error{Code: CodeInvalid, Field: "template", Message: "no template " + ref + " in project " + project.Key,
		Allowed: names, Nearest: nearest(ref, names)}
}

// applyTemplate fills what the caller left empty on a new task from a
// template, and returns the decision the template opens, if any.
func (c *cx) applyTemplate(project core.Project, a *taskCreateArgs) (*decisionOpenArgs, error) {
	tp, err := c.loadTemplate(project, a.Template)
	if err != nil {
		return nil, err
	}
	if a.Title == "" {
		a.Title = tp.Title
	} else if tp.Title != "" && !strings.HasPrefix(a.Title, tp.Title) && strings.HasSuffix(tp.Title, " ") {
		a.Title = tp.Title + a.Title // a title ending in a space is a prefix
	}
	if a.Description == "" {
		a.Description = tp.Description
	}
	var ps Preset
	if len(tp.Preset) > 0 {
		if err := json.Unmarshal(tp.Preset, &ps); err != nil {
			return nil, err
		}
	}
	if a.Status == "" {
		a.Status = ps.Status
	}
	if a.Priority == 0 {
		a.Priority = ps.Priority
	}
	if len(a.Labels) == 0 {
		a.Labels = ps.Labels
	}
	if a.Assignee == "" {
		a.Assignee = ps.Assignee
	}
	if a.Estimate == 0 {
		a.Estimate = ps.Estimate
	}
	return ps.Decision, nil
}
