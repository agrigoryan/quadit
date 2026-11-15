package server

import (
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// hContext is the context pack: one call with everything an agent needs to
// work on a task.
func (s *Server) hContext(x *c) error {
	t, err := x.taskByRef(x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	d, err := x.detail(t, x.maxChars())
	if err != nil {
		return err
	}
	p := &contextPack{x: x, t: t, out: map[string]any{"task": d}}
	p.text.WriteString(d.text())
	for _, part := range []func() error{p.parents, p.epic, p.preferences, p.recentDecisions, p.docs} {
		if err := part(); err != nil {
			return err
		}
	}
	if x.wantText() {
		return x.text(p.text.String())
	}
	return x.ok(p.out)
}

// contextPack is one task's context pack in the making, in both its forms:
// each part adds to the answer and to the text.
type contextPack struct {
	x    *c
	t    core.Task
	out  map[string]any
	text strings.Builder
}

// parents adds the chain of parents, which says what this task is part of.
func (p *contextPack) parents() error {
	x := p.x
	var parents []taskView
	for cur, depth := p.t.ParentID, 0; cur != "" && depth < 5; depth++ {
		var up core.Task
		if err := x.db.Get(x.ctx(), &up, store.Eq("id", cur)); err != nil {
			break
		}
		pv, _ := x.taskViews([]core.Task{up}, true)
		pv[0].Description, pv[0].Truncated = cut(pv[0].Description, 1500)
		parents = append(parents, pv[0])
		cur = up.ParentID
	}
	if len(parents) > 0 {
		p.out["parents"] = parents
		p.text.WriteString("=== part of\n")
		for _, v := range parents {
			fmt.Fprintf(&p.text, "%s\n%s\n", v.line(), v.Description)
		}
	}
	return nil
}

// epic adds the epic the task is in.
func (p *contextPack) epic() error {
	nm, _ := p.x.names()
	if e, ok := nm.epics[p.t.EpicID]; ok {
		desc, _ := cut(e.Description, 2000)
		p.out["epic"] = map[string]any{"name": e.Name, "state": e.State, "target_on": e.TargetOn, "description": desc}
		fmt.Fprintf(&p.text, "=== epic: %s (%s", e.Name, e.State)
		if e.TargetOn != "" {
			p.text.WriteString(", target " + e.TargetOn)
		}
		p.text.WriteString(")\n" + desc + "\n")
	}
	return nil
}

// preferences adds the standing preferences: the workspace's, the
// project's, and those tied to this task's labels.
func (p *contextPack) preferences() error {
	t := p.t
	var prefs []core.Preference
	if err := p.x.db.List(p.x.ctx(), &prefs, store.Where(store.Live, store.Null("retired_at"))); err != nil {
		return err
	}
	var rules []string
	for _, pr := range prefs {
		if pr.ProjectID != "" && pr.ProjectID != t.ProjectID {
			continue
		}
		if len(pr.LabelIDs) > 0 {
			match := false
			for _, l := range pr.LabelIDs {
				match = match || has(t.LabelIDs, l)
			}
			if !match {
				continue
			}
		}
		rules = append(rules, pr.Body)
	}
	if len(rules) > 0 {
		p.out["standing_preferences"] = rules
		p.text.WriteString("=== standing preferences\n- " + strings.Join(rules, "\n- ") + "\n")
	}
	return nil
}

// recentDecisions adds earlier answers in the same project, which guide
// later work.
func (p *contextPack) recentDecisions() error {
	x, ctx, t := p.x, p.x.ctx(), p.t
	var picked []core.Decision
	if err := x.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: 200}); err != nil {
		return err
	}
	var recent []core.Decision
	for _, dc := range picked {
		if dc.TaskID == t.ID || len(recent) >= 8 {
			continue
		}
		var dt core.Task
		if err := x.db.Get(ctx, &dt, store.Eq("id", dc.TaskID)); err == nil && dt.ProjectID == t.ProjectID {
			recent = append(recent, dc)
		}
	}
	if rv, err := x.decisionViews(recent, false); err == nil && len(rv) > 0 {
		p.out["recent_decisions"] = rv
		p.text.WriteString("=== recent decisions in this project\n")
		for _, r := range rv {
			ans := r.Outcome
			if r.PickedLabel != "" {
				ans = r.PickedLabel
			}
			fmt.Fprintf(&p.text, "%s %q -> %s", r.Task, oneLine(r.Question, 100), ans)
			if r.Note != "" {
				p.text.WriteString(": " + oneLine(r.Note, 160))
			}
			p.text.WriteString("\n")
		}
	}
	return nil
}

// docs adds the docs this task mentions, or that mention it.
func (p *contextPack) docs() error {
	x, ctx, t := p.x, p.x.ctx(), p.t
	var refs []core.Ref
	x.db.List(ctx, &refs, store.Where(store.Eq("from_scope_id", t.ID), store.Eq("to_type", "doc")))
	var back []core.Ref
	x.db.List(ctx, &back, store.Where(store.Eq("to_id", t.ID), store.Eq("from_scope_type", "doc")))
	docIDs := map[string]bool{}
	for _, r := range refs {
		docIDs[r.ToID] = true
	}
	for _, r := range back {
		docIDs[r.FromScopeID] = true
	}
	var docs []map[string]any
	for did := range docIDs {
		var doc core.Doc
		if err := x.db.Get(ctx, &doc, store.Eq("id", did), store.Live); err == nil && engine.CanSeeDoc(doc, x.member.UserID) {
			docs = append(docs, map[string]any{"id": doc.ID, "title": doc.Title, "url": x.s.cfg.BaseURL + "/" + x.ws.Slug + "/docs/" + doc.ID})
		}
	}
	if len(docs) > 0 {
		p.out["docs"] = docs
		p.text.WriteString("=== linked docs\n")
		for _, dc := range docs {
			fmt.Fprintf(&p.text, "%s  (doc %s)\n", dc["title"], dc["id"])
		}
	}
	return nil
}

// namedRef is one mention with what the mentioning thing is called.
type namedRef struct {
	core.Ref
	// Title is the page's title or the task's; Key the task's key, when the
	// mention is in a task or one of its comments.
	Title string `json:"title,omitempty"`
	Key   string `json:"key,omitempty"`
}

// namedRefs gives each mention the name of where it was made, leaving out
// those the caller may not see.
func (x *c) namedRefs(refs []core.Ref) []namedRef {
	out := []namedRef{}
	ctx := x.ctx()
	for _, r := range refs {
		nr := namedRef{Ref: r}
		switch r.FromScopeType {
		case "doc":
			var d core.Doc
			if err := x.db.Get(ctx, &d, store.Eq("id", r.FromScopeID), store.Live); err != nil || !engine.CanSeeDoc(d, x.member.UserID) || !x.canProject(d.ProjectID) {
				continue
			}
			nr.Title = d.Title
		case "task":
			var t core.Task
			if err := x.db.Get(ctx, &t, store.Eq("id", r.FromScopeID), store.Live); err != nil || !x.canProject(t.ProjectID) {
				continue
			}
			nr.Title, nr.Key = t.Title, t.Key
		}
		out = append(out, nr)
	}
	return out
}
