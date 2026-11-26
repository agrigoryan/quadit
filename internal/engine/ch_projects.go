// project.create, project.update and project.delete.

package engine

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
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
	Key         string                `json:"key" quadit:"required,handler"`
	Name        string                `json:"name" quadit:"required,handler"`
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

// projectCreate makes a project with the default statuses.
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
	if a.Settings != nil {
		settings, err := newSettings(nil, *a.Settings)
		if err != nil {
			return err
		}
		a.Settings = &settings
	}
	rk, err := nextRank[core.Project](c, store.Live)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	project := core.Project{ID: pid, WorkspaceID: c.ws, Key: a.Key, Name: strings.TrimSpace(a.Name), Description: a.Description,
		Icon: a.Icon, Color: a.Color, LeadID: lead, Rank: rk, Settings: a.Settings,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, CreatedSeq: seq, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, project); err != nil {
		return alreadyInUse(err, "project key", a.Key)
	}
	if err := c.created(seq, "project", project.ID, inProject(project.ID), project); err != nil {
		return err
	}
	for i, status := range defaultStatuses {
		seq := c.tx.NextSeq()
		st := core.Status{ID: id.New(), WorkspaceID: c.ws, ProjectID: project.ID, Name: status.name, Color: status.color, Category: status.category,
			Rank: rank.ForNumber(i + 1), IsDefault: status.category == core.CatUnstarted, CreatedAt: c.at, UpdatedSeq: seq}
		if err := c.tx.Insert(c.ctx, st); err != nil {
			return err
		}
		if err := c.emit(event{seq: seq, typ: "status.created", entity: "status", entityID: st.ID, place: inProject(project.ID), data: core.EventData{Row: st}}); err != nil {
			return err
		}
	}
	c.ref, c.key = project.ID, project.Key
	return c.startCycles(project)
}

type projectUpdateArgs struct {
	ID          string                    `json:"id" quadit:"required,handler"`
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

// projectUpdate changes a project; a new key gives its tasks new keys.
func projectUpdate(c *cx, a projectUpdateArgs) error {
	pr, err := c.project(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	oldKey := pr.Key
	if err := projectKey(p, a.Key, &pr); err != nil {
		return err
	}
	if err := p.name("name", a.Name, &pr.Name); err != nil {
		return err
	}
	p.setText("description", a.Description, &pr.Description)
	p.setText("icon", a.Icon, &pr.Icon)
	p.setText("color", a.Color, &pr.Color)
	if err := c.projectLead(p, a.Lead, pr); err != nil {
		return err
	}
	if err := p.rank(a.Rank, &pr.Rank); err != nil {
		return err
	}
	if err := projectSettings(p, a.Settings, pr); err != nil {
		return err
	}
	p.setStamp("archived_at", a.Archived, pr.ArchivedAt, c.at)
	if !p.empty() {
		p.set["updated_at"] = c.at
	}
	if err := c.save(p, target{table: "projects", entity: "project", id: pr.ID, place: inProject(pr.ID)}); err != nil {
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

// projectKey applies a new project key, written in upper case.
func projectKey(p *patch, key Opt[string], pr *core.Project) error {
	if !key.Set {
		return nil
	}
	key.V = strings.ToUpper(strings.TrimSpace(key.V))
	if !projectKeyRE.MatchString(key.V) {
		return invalid("key", "a project key is 2 to 10 upper-case letters or digits, starting with a letter")
	}
	p.setText("key", key, &pr.Key)
	return nil
}

// projectLead applies a new lead, a member; null leaves the project without one.
func (c *cx) projectLead(p *patch, lead Opt[string], pr core.Project) error {
	if !lead.Set {
		return nil
	}
	leadID := ""
	if !lead.Null {
		var err error
		if leadID, err = c.optMember("lead", lead.V); err != nil {
			return err
		}
	}
	p.put("lead_id", pr.LeadID, leadID)
	return nil
}

// projectSettings applies new settings, as a whole (see newSettings).
func projectSettings(p *patch, settings Opt[core.ProjectSettings], pr core.Project) error {
	if !settings.Set {
		return nil
	}
	s, err := newSettings(pr.Settings, settings.V)
	if err != nil {
		return err
	}
	var old core.ProjectSettings
	if pr.Settings != nil {
		old = *pr.Settings
	}
	if old != s {
		p.set["settings"] = &s
		p.changes["settings"] = core.FieldChange{From: pr.Settings, To: &s}
	}
	return nil
}

// newSettings checks a project's settings as sent, replacing old (nil for a
// new project), and fills in what the server decides: a cycle's length,
// and the scale of a project that estimates and names none. Turning
// estimates on starts on the Fibonacci scale; a project that already
// estimated with no scale named (one made before scales) keeps any whole
// number, which it now names.
func newSettings(old *core.ProjectSettings, s core.ProjectSettings) (core.ProjectSettings, error) {
	if s.Cycles && s.CycleDays == 0 {
		s.CycleDays = defaultCycleDays
	}
	if s.CycleDays < 0 || s.CycleDays > 90 || s.CycleStart < 0 || s.CycleStart > 6 {
		return s, invalid("settings", "cycle_days is 1 to 90 and cycle_start is a weekday, 0 (Sunday) to 6")
	}
	s.EstimateScale = strings.ToLower(strings.TrimSpace(s.EstimateScale))
	switch {
	case s.EstimateScale != "" && !slices.Contains(core.EstimateScales, s.EstimateScale):
		return s, &Error{Code: CodeInvalid, Field: "settings", Message: fmt.Sprintf("unknown estimate_scale %q", s.EstimateScale),
			Allowed: core.EstimateScales, Nearest: nearest(s.EstimateScale, core.EstimateScales)}
	case !s.Estimates || s.EstimateScale != "":
	case old == nil || !old.Estimates:
		s.EstimateScale = core.ScaleFibonacci
	default:
		s.EstimateScale = core.ScalePoints
	}
	return s, nil
}

// rekeyTasks gives a project's tasks, the trash included, keys under the
// project's new key. Task keys follow the project key. The old keys stop
// resolving.
func (c *cx) rekeyTasks(pr core.Project) error {
	rekey := func(t core.Task) error {
		_, err := c.tx.Update(c.ctx, "tasks", map[string]any{"key": pr.Key + "-" + strconv.Itoa(t.Number)}, store.Eq("id", t.ID))
		return err
	}
	if err := c.eachTask(store.TaskFilter{ProjectIDs: []string{pr.ID}, Archived: true}, rekey); err != nil {
		return err
	}
	return c.eachTask(store.TaskFilter{ProjectIDs: []string{pr.ID}, InTrash: true}, rekey)
}

func projectDelete(c *cx, a memberRefArgs) error {
	pr, err := c.project(a.ID)
	if err != nil {
		return err
	}
	return c.trash(target{table: "projects", entity: "project", id: pr.ID, place: inProject(pr.ID), extra: core.EventData{Key: &pr.Key}})
}
