// Search (/search) and the decision log (/decisions).

package server

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleSearch finds tasks, comments, pages and epics by their words: q= the
// words, kind= the kinds of thing. Each hit says where it is: a task by its
// key, and the address to open it at. Hits in the trash are left out.
func (s *Server) handleSearch(x *c) error {
	v := x.r.URL.Query()
	hits, err := x.db.Search(x.ctx(), store.SearchQuery{Text: v.Get("q"), Kinds: splitList(v.Get("kind")), ProjectIDs: x.projects,
		Viewer: x.member.UserID, Limit: x.intParam("limit", defaultSearchHits)})
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
		tasks, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: taskIDs, Archived: true, Limit: maxTaskPage})
		if err != nil {
			return err
		}
		for _, t := range tasks {
			keys[t.ID] = t.Key
		}
	}
	base := s.cfg.BaseURL + "/" + x.ws.Slug
	for _, h := range hits {
		found := hit{SearchHit: h}
		switch h.ScopeType {
		case "task":
			if keys[h.ScopeID] == "" {
				continue // in the trash
			}
			found.Task, found.URL = keys[h.ScopeID], base+"/task/"+keys[h.ScopeID]
		case "doc":
			found.URL = base + "/docs/" + h.ScopeID
		case "epic":
			found.URL = base + "/epic/" + h.ScopeID
		}
		out = append(out, found)
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
// the choice, the reason and the date, and the files on the question and on
// each option, as on the task.
func (s *Server) handleListDecisions(x *c) error {
	v := x.r.URL.Query()
	conds, err := x.decisionConds()
	if err != nil {
		return err
	}
	var decisions []core.Decision
	if err := x.db.List(x.ctx(), &decisions, store.Q{Where: conds, Order: "-updated_seq", Limit: min(x.intParam("limit", defaultDecisionPage), maxDecisionPage), Offset: x.intParam("offset", 0)}); err != nil {
		return err
	}
	if decisions, err = x.decisionsInProjects(x.ctx(), decisions, splitList(v.Get("project"))); err != nil {
		return err
	}
	views, err := x.decisionViewsWithFiles(x.ctx(), decisions)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(lines(views, decisionLogLine, "no decisions"))
	}
	return x.ok(map[string]any{"decisions": views})
}

// The decision log lists defaultDecisionPage decisions unless limit= says
// otherwise, and never more than maxDecisionPage; a search gives
// defaultSearchHits.
const (
	defaultDecisionPage = 50
	maxDecisionPage     = 500
	defaultSearchHits   = 20
)

// decisionConds reads from the request which decisions the log is asked
// for: by state, by what changed since a position, by words of the question,
// by who was asked.
func (x *c) decisionConds() ([]store.Cond, error) {
	v := x.r.URL.Query()
	conds := []store.Cond{store.Live}
	if truthyParam(v, "trash") {
		conds = []store.Cond{store.NotNull("deleted_at")}
	}
	switch state := v.Get("state"); state {
	case "", "answered":
		if truthyParam(v, "trash") {
			break // the trash holds decisions in any state
		}
		conds = append(conds, store.Ne("state", core.StateOpen))
	case "all":
	case core.StateOpen, core.StatePicked, core.StateSentBack:
		conds = append(conds, store.Eq("state", state))
	default:
		return nil, &engine.Error{Code: engine.CodeInvalid, Field: "state", Message: "unknown state " + state, Allowed: []string{"answered", "open", "picked", "sent_back", "all"}}
	}
	if since := x.intParam("since", -1); since >= 0 {
		conds = append(conds, store.Gt("updated_seq", int64(since))) // only what changed after that position
	}
	if words := v.Get("q"); words != "" {
		conds = append(conds, store.Like("question", "%"+strings.NewReplacer("%", "", "_", " ").Replace(words)+"%"))
	}
	if ref := v.Get("asked"); ref != "" {
		asked, err := x.resolver(x.ctx()).Member("asked", ref)
		if err != nil {
			return nil, err
		}
		conds = append(conds, store.Eq("asked_id", asked.UserID))
	}
	return conds, nil
}

// decisionsInProjects keeps to the projects asked for, and to those the
// caller may read.
func (who *viewer) decisionsInProjects(ctx context.Context, decisions []core.Decision, refs []string) ([]core.Decision, error) {
	var projectIDs []string
	for _, ref := range refs {
		project, err := who.resolver(ctx).Project(ref)
		if err != nil {
			return nil, err
		}
		projectIDs = append(projectIDs, project.ID)
	}
	if len(projectIDs) == 0 && who.projects == nil {
		return decisions, nil
	}
	var taskIDs []string
	for _, decision := range decisions {
		taskIDs = append(taskIDs, decision.TaskID)
	}
	tasks, err := who.db.Tasks(ctx, store.TaskFilter{IDs: taskIDs, Archived: true, Limit: maxTasksByID})
	if err != nil {
		return nil, err
	}
	okTask := map[string]bool{}
	for _, t := range tasks {
		okTask[t.ID] = who.canProject(t.ProjectID) && (len(projectIDs) == 0 || slices.Contains(projectIDs, t.ProjectID))
	}
	return keep(decisions, func(decision core.Decision) bool { return okTask[decision.TaskID] }), nil
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
	var b strings.Builder
	fmt.Fprintf(&b, "%s  %s  %q -> %s", at, d.Task, oneLine(d.Question, 100), ans)
	if d.Note != "" {
		b.WriteString(": " + oneLine(d.Note, 200))
	}
	for _, a := range d.Attachments {
		b.WriteString("\n    " + fileLine(a))
	}
	for _, o := range d.Options {
		for _, a := range o.Attachments {
			fmt.Fprintf(&b, "\n    option %d %s", o.N, fileLine(a))
		}
	}
	return b.String()
}
