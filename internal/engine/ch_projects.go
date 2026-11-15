package engine

import (
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("project.create", core.RoleAdmin, projectCreate)
	register("project.update", core.RoleAdmin, projectUpdate)
	register("project.delete", core.RoleAdmin, projectDelete)
}

var projectKeyRE = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

type projectCreateArgs struct {
	ID          string                `json:"id"`
	Key         string                `json:"key"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Icon        string                `json:"icon"`
	Color       string                `json:"color"`
	Lead        string                `json:"lead"`
	Settings    *core.ProjectSettings `json:"settings"`
}

// defaultStatuses is what a new project starts with. "Waiting" is its own
// category so "who has the next move" is visible on every board.
var defaultStatuses = []struct{ name, category, color string }{
	{"Backlog", core.CatBacklog, "#9ca3af"},
	{"Todo", core.CatUnstarted, "#6b7280"},
	{"In Progress", core.CatStarted, "#f59e0b"},
	{"Waiting", core.CatWaiting, "#8b5cf6"},
	{"Done", core.CatDone, "#10b981"},
	{"Canceled", core.CatCanceled, "#ef4444"},
}

func projectCreate(c *cx, a projectCreateArgs) error {
	pid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	a.Key = strings.ToUpper(strings.TrimSpace(a.Key))
	if !projectKeyRE.MatchString(a.Key) {
		return invalid("key", "a project key is 2 to 10 upper-case letters or digits, starting with a letter (it prefixes task numbers: SVA-12)")
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a project needs a name")
	}
	lead, err := c.optMember("lead", a.Lead)
	if err != nil {
		return err
	}
	rk, err := nextRank[core.Project](c, store.Live)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	p := core.Project{ID: pid, WorkspaceID: c.ws, Key: a.Key, Name: strings.TrimSpace(a.Name), Description: a.Description,
		Icon: a.Icon, Color: a.Color, LeadID: lead, Rank: rk, Settings: a.Settings,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, CreatedSeq: seq, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, p); err != nil {
		return alreadyInUse(err, "project key", a.Key)
	}
	if err := c.created(seq, "project", p.ID, "project", p.ID, p.ID, p); err != nil {
		return err
	}
	for i, d := range defaultStatuses {
		seq := c.tx.NextSeq()
		st := core.Status{ID: id.New(), WorkspaceID: c.ws, ProjectID: p.ID, Name: d.name, Color: d.color, Category: d.category,
			Rank: rank.ForNumber(i + 1), IsDefault: d.category == core.CatUnstarted, CreatedAt: c.at, UpdatedSeq: seq}
		if err := c.tx.Insert(c.ctx, st); err != nil {
			return err
		}
		if err := c.emit(seq, "status.created", "status", st.ID, "project", p.ID, p.ID, map[string]any{"row": st}); err != nil {
			return err
		}
	}
	c.ref, c.key = p.ID, p.Key
	return c.startCycles(p)
}

type projectUpdateArgs struct {
	ID          string                    `json:"id"`
	Key         Opt[string]               `json:"key"`
	Name        Opt[string]               `json:"name"`
	Description Opt[string]               `json:"description"`
	Icon        Opt[string]               `json:"icon"`
	Color       Opt[string]               `json:"color"`
	Lead        Opt[string]               `json:"lead"`
	Rank        Opt[string]               `json:"rank"`
	Settings    Opt[core.ProjectSettings] `json:"settings"`
	Archived    Opt[bool]                 `json:"archived"`
}

func projectUpdate(c *cx, a projectUpdateArgs) error {
	pr, err := c.project(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	oldKey := pr.Key
	if a.Key.Set {
		a.Key.V = strings.ToUpper(strings.TrimSpace(a.Key.V))
		if !projectKeyRE.MatchString(a.Key.V) {
			return invalid("key", "a project key is 2 to 10 upper-case letters or digits, starting with a letter")
		}
		p.setText("key", a.Key, &pr.Key)
	}
	if err := p.name("name", a.Name, &pr.Name); err != nil {
		return err
	}
	p.setText("description", a.Description, &pr.Description)
	p.setText("icon", a.Icon, &pr.Icon)
	p.setText("color", a.Color, &pr.Color)
	if a.Lead.Set {
		lead := ""
		if !a.Lead.Null {
			if lead, err = c.optMember("lead", a.Lead.V); err != nil {
				return err
			}
		}
		p.put("lead_id", pr.LeadID, lead)
	}
	if err := p.rank(a.Rank, &pr.Rank); err != nil {
		return err
	}
	if a.Settings.Set {
		s := a.Settings.V
		if s.Cycles && s.CycleDays == 0 {
			s.CycleDays = 14
		}
		if s.CycleDays < 0 || s.CycleDays > 90 || s.CycleStart < 0 || s.CycleStart > 6 {
			return invalid("settings", "cycle_days is 1 to 90 and cycle_start is a weekday, 0 (Sunday) to 6")
		}
		var old core.ProjectSettings
		if pr.Settings != nil {
			old = *pr.Settings
		}
		if old != s {
			p.set["settings"] = &s
			p.changes["settings"] = core.FieldChange{From: pr.Settings, To: &s}
		}
	}
	if a.Archived.Set {
		if a.Archived.V && pr.ArchivedAt == 0 {
			p.put("archived_at", int64(0), c.at)
		} else if !a.Archived.V && pr.ArchivedAt != 0 {
			p.put("archived_at", pr.ArchivedAt, int64(0))
		}
	}
	if !p.empty() {
		p.set["updated_at"] = c.at
	}
	if err := c.save(p, "projects", "project", pr.ID, "project", pr.ID, pr.ID, nil); err != nil {
		return alreadyInUse(err, "project key", pr.Key)
	}
	if pr.Key != oldKey {
		if err := c.rekeyTasks(pr); err != nil {
			return err
		}
	}
	c.key = pr.Key
	if sp, ok := p.set["settings"].(*core.ProjectSettings); ok {
		pr.Settings = sp
		return c.startCycles(pr)
	}
	return nil
}

// rekeyTasks gives a project's tasks, the trash included, keys under the
// project's new key. Task keys follow the project key. The old keys stop
// resolving.
func (c *cx) rekeyTasks(pr core.Project) error {
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{ProjectIDs: []string{pr.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	trashed, err := c.tx.Tasks(c.ctx, store.TaskFilter{ProjectIDs: []string{pr.ID}, InTrash: true, Limit: 5000})
	if err != nil {
		return err
	}
	for _, t := range append(tasks, trashed...) {
		if _, err := c.tx.Update(c.ctx, "tasks", map[string]any{"key": pr.Key + "-" + itoa(t.Number)}, store.Eq("id", t.ID)); err != nil {
			return err
		}
	}
	return nil
}

func projectDelete(c *cx, a memberRefArgs) error {
	pr, err := c.project(a.ID)
	if err != nil {
		return err
	}
	return c.trash("projects", "project", pr.ID, "project", pr.ID, pr.ID, map[string]any{"key": pr.Key})
}
