package server

import (
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

func (s *Server) handleSearch(x *c) error {
	v := x.r.URL.Query()
	hits, err := x.db.Search(x.ctx(), store.SearchQuery{Text: v.Get("q"), Kinds: splitList(v.Get("kind")), ProjectIDs: x.projects,
		Viewer: x.member.UserID, Limit: x.intParam("limit", 20)})
	if err != nil {
		return err
	}
	type hit struct {
		store.SearchHit
		Task string `json:"task,omitempty"`
		URL  string `json:"url"`
	}
	out := make([]hit, 0, len(hits))
	var taskIDs []string
	for _, h := range hits {
		if h.ScopeType == "task" {
			taskIDs = append(taskIDs, h.ScopeID)
		}
	}
	keys := map[string]string{}
	if len(taskIDs) > 0 {
		ts, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: taskIDs, Archived: true, Limit: 1000})
		if err != nil {
			return err
		}
		for _, t := range ts {
			keys[t.ID] = t.Key
		}
	}
	base := s.cfg.BaseURL + "/" + x.ws.Slug
	for _, h := range hits {
		hh := hit{SearchHit: h}
		switch h.ScopeType {
		case "task":
			if keys[h.ScopeID] == "" {
				continue // in the trash
			}
			hh.Task, hh.URL = keys[h.ScopeID], base+"/task/"+keys[h.ScopeID]
		case "doc":
			hh.URL = base + "/docs/" + h.ScopeID
		case "epic":
			hh.URL = base + "/epic/" + h.ScopeID
		}
		out = append(out, hh)
	}
	if x.wantText() {
		return x.text(lines(out, func(h hit) string {
			where := h.Task
			if where == "" {
				where = h.ScopeType + " " + h.ScopeID
			}
			title := strings.TrimSpace(strings.TrimPrefix(h.Title, where))
			return fmt.Sprintf("%s  %s  %s — %s", h.Kind, where, oneLine(title, 80), oneLine(h.Snippet, 160))
		}, "nothing found"))
	}
	return x.ok(map[string]any{"hits": out})
}

// handleListDecisions is the decision log: every question with the options shown,
// the choice, the reason and the date.
func (s *Server) handleListDecisions(x *c) error {
	v := x.r.URL.Query()
	conds, err := x.decisionConds()
	if err != nil {
		return err
	}
	var ds []core.Decision
	if err := x.db.List(x.ctx(), &ds, store.Q{Where: conds, Order: "-updated_seq", Limit: min(x.intParam("limit", 50), 500), Offset: x.intParam("offset", 0)}); err != nil {
		return err
	}
	if ds, err = x.decisionsInProjects(ds, splitList(v.Get("project"))); err != nil {
		return err
	}
	views, err := x.decisionViews(ds, false)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(lines(views, decisionLogLine, "no decisions"))
	}
	return x.ok(map[string]any{"decisions": views})
}

// decisionConds reads from the request which decisions the log is asked
// for: by state, by what changed since a position, by words of the question,
// by who was asked.
func (x *c) decisionConds() ([]store.Cond, error) {
	v := x.r.URL.Query()
	conds := []store.Cond{store.Live}
	if truthyParam(v, "trash") {
		conds = []store.Cond{store.NotNull("deleted_at")}
	}
	switch st := v.Get("state"); st {
	case "", "answered":
		if truthyParam(v, "trash") {
			break // the trash holds decisions in any state
		}
		conds = append(conds, store.Ne("state", core.StateOpen))
	case "all":
	case core.StateOpen, core.StatePicked, core.StateSentBack:
		conds = append(conds, store.Eq("state", st))
	default:
		return nil, &engine.Error{Code: engine.CodeInvalid, Field: "state", Message: "unknown state " + st, Allowed: []string{"answered", "open", "picked", "sent_back", "all"}}
	}
	if since := x.intParam("since", -1); since >= 0 {
		conds = append(conds, store.Gt("updated_seq", int64(since))) // only what changed after that position
	}
	if q := v.Get("q"); q != "" {
		conds = append(conds, store.Like("question", "%"+strings.NewReplacer("%", "", "_", " ").Replace(q)+"%"))
	}
	if a := v.Get("asked"); a != "" {
		m, err := x.resolver().Member("asked", a)
		if err != nil {
			return nil, err
		}
		conds = append(conds, store.Eq("asked_id", m.UserID))
	}
	return conds, nil
}

// decisionsInProjects keeps to the projects asked for, and to those the
// caller may read.
func (x *c) decisionsInProjects(ds []core.Decision, refs []string) ([]core.Decision, error) {
	var projectIDs []string
	for _, ref := range refs {
		p, err := x.resolver().Project(ref)
		if err != nil {
			return nil, err
		}
		projectIDs = append(projectIDs, p.ID)
	}
	if len(projectIDs) == 0 && x.projects == nil {
		return ds, nil
	}
	var tids []string
	for _, d := range ds {
		tids = append(tids, d.TaskID)
	}
	ts, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: tids, Archived: true, Limit: 5000})
	if err != nil {
		return nil, err
	}
	okTask := map[string]bool{}
	for _, t := range ts {
		okTask[t.ID] = x.canProject(t.ProjectID) && (len(projectIDs) == 0 || has(projectIDs, t.ProjectID))
	}
	return keep(ds, func(d core.Decision) bool { return okTask[d.TaskID] }), nil
}

// decisionLogLine is one decision of the log as a line of text.
func decisionLogLine(d decisionView) string {
	ans := d.Outcome
	if d.PickedLabel != "" {
		ans = fmt.Sprintf("%s (%s)", d.PickedLabel, d.Outcome)
	}
	if d.State == core.StateOpen {
		ans = "open, asked " + d.Asked
	}
	at := d.DecidedAt
	if at == "" {
		at = d.AskedAt
	}
	l := fmt.Sprintf("%s  %s  %q -> %s", at, d.Task, oneLine(d.Question, 100), ans)
	if d.Note != "" {
		l += ": " + oneLine(d.Note, 200)
	}
	return l
}
