package server

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// hLayout describes one project: its statuses, labels, members, epics,
// cycles and templates, by name.
func (s *Server) hLayout(x *c) error {
	p, err := x.resolver().Project(x.r.PathValue("key"))
	if err != nil {
		return err
	}
	if !x.canProject(p.ID) {
		return errNotFound("project " + p.Key)
	}
	out, err := x.layout(p)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(layoutText(p, out))
	}
	return x.ok(map[string]any{"project": map[string]string{"key": p.Key, "name": p.Name, "description": p.Description}, "layout": out})
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
// other lists by name.
func (x *c) layout(p core.Project) (map[string][]layoutItem, error) {
	nm, err := x.names()
	if err != nil {
		return nil, err
	}
	out := map[string][]layoutItem{}
	var sts []core.Status
	for _, st := range nm.statuses {
		if st.ProjectID == p.ID && st.DeletedAt == 0 {
			sts = append(sts, st)
		}
	}
	sort.Slice(sts, func(i, j int) bool { return sts[i].Rank < sts[j].Rank })
	for _, st := range sts {
		out["statuses"] = append(out["statuses"], layoutItem{Name: st.Name, Category: st.Category, Default: st.IsDefault})
	}
	for _, l := range nm.labels {
		if (l.ProjectID == "" || l.ProjectID == p.ID) && l.DeletedAt == 0 {
			out["labels"] = append(out["labels"], layoutItem{Name: l.Name})
		}
	}
	for _, m := range nm.members {
		if m.RemovedAt == 0 {
			out["members"] = append(out["members"], layoutItem{Name: "@" + m.Handle, Role: string(m.Role), Kind: m.Kind, Title: m.Name})
		}
	}
	for _, e := range nm.epics {
		if e.ProjectID == p.ID && e.DeletedAt == 0 {
			out["epics"] = append(out["epics"], layoutItem{Name: e.Name, State: e.State, Dates: e.TargetOn})
		}
	}
	today := time.Now().UTC().Format("2006-01-02")
	for _, cy := range nm.cycles {
		if cy.ProjectID == p.ID && cy.DeletedAt == 0 && cy.EndsOn >= today {
			out["cycles"] = append(out["cycles"], layoutItem{Name: fmt.Sprint(cy.Number), Dates: cy.StartsOn + " to " + cy.EndsOn})
		}
	}
	var tpls []core.Template
	if err := x.db.List(x.ctx(), &tpls, store.Where(store.Live)); err != nil {
		return nil, err
	}
	for _, t := range tpls {
		if t.ProjectID == "" || t.ProjectID == p.ID {
			out["templates"] = append(out["templates"], layoutItem{Name: t.Name})
		}
	}
	for k := range out {
		list := out[k]
		if k != "statuses" {
			sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		}
	}
	return out, nil
}

// layoutText is a layout as lines of text, one list on each.
func layoutText(p core.Project, out map[string][]layoutItem) string {
	var b strings.Builder
	fmt.Fprintf(&b, "project %s  %s\n", p.Key, p.Name)
	for _, k := range []string{"statuses", "labels", "members", "epics", "cycles", "templates"} {
		var parts []string
		for _, n := range out[k] {
			s := n.Name
			if n.Category != "" {
				s += " (" + n.Category + ")"
			}
			if n.Kind == core.KindAgent {
				s += " (agent)"
			}
			if n.Dates != "" {
				s += " (" + n.Dates + ")"
			}
			parts = append(parts, s)
		}
		if len(parts) > 0 {
			fmt.Fprintf(&b, "%s: %s\n", k, strings.Join(parts, ", "))
		}
	}
	return b.String()
}
