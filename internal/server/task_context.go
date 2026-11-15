// The context pack: one task with what surrounds it, for an agent about to work on it.

package server

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowTaskContext is the context pack: one call with everything an agent needs to
// work on a task.
func (s *Server) handleShowTaskContext(x *c) error {
	t, err := x.taskByRef(x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	detail, err := x.buildTaskDetail(t, x.maxChars())
	if err != nil {
		return err
	}
	pack := &contextPack{x: x, t: t, out: map[string]any{"task": detail}}
	pack.text.WriteString(detail.text())
	for _, part := range []func() error{pack.parents, pack.epic, pack.preferences, pack.recentDecisions, pack.docs} {
		if err := part(); err != nil {
			return err
		}
	}
	if x.wantText() {
		return x.text(pack.text.String())
	}
	return x.ok(pack.out)
}

// contextPack is one task's context pack in the making, in both its forms:
// each part adds to the answer and to the text.
type contextPack struct {
	x    *c
	t    core.Task
	out  map[string]any
	text strings.Builder
}

// The pack stays a size an agent reads in one go: how far up the chain of
// parents it looks, how much of each description it keeps, and how many
// earlier decisions it shows.
const (
	packParentDepth      = 5
	packParentChars      = 1500
	packEpicChars        = 2000
	packRecentDecisions  = 8
	packDecisionsToCheck = 200
)

// parents adds the chain of parents, which says what this task is part of.
// A parent that is gone ends the chain.
func (pack *contextPack) parents() error {
	x := pack.x
	var parents []taskView
	for cur, depth := pack.t.ParentID, 0; cur != "" && depth < packParentDepth; depth++ {
		var up core.Task
		err := x.db.Get(x.ctx(), &up, store.Eq("id", cur))
		if errors.Is(err, store.ErrNotFound) {
			break
		}
		if err != nil {
			return err
		}
		views, err := x.detailedTaskViews([]core.Task{up})
		if err != nil {
			return err
		}
		parent := views[0]
		parent.Description, parent.Truncated = truncate(parent.Description, packParentChars)
		parents = append(parents, parent)
		cur = up.ParentID
	}
	if len(parents) > 0 {
		pack.out["parents"] = parents
		pack.text.WriteString("=== part of\n")
		for _, v := range parents {
			fmt.Fprintf(&pack.text, "%s\n%s\n", v.line(), v.Description)
		}
	}
	return nil
}

// epic adds the epic the task is in.
func (pack *contextPack) epic() error {
	names, err := pack.x.names()
	if err != nil {
		return err
	}
	if e, ok := names.epics[pack.t.EpicID]; ok {
		desc, _ := truncate(e.Description, packEpicChars)
		pack.out["epic"] = map[string]any{"name": e.Name, "state": e.State, "target_on": e.TargetOn, "description": desc}
		fmt.Fprintf(&pack.text, "=== epic: %s (%s", e.Name, e.State)
		if e.TargetOn != "" {
			pack.text.WriteString(", target " + e.TargetOn)
		}
		pack.text.WriteString(")\n" + desc + "\n")
	}
	return nil
}

// preferences adds the standing preferences: the workspace's, the
// project's, and those tied to this task's labels.
func (pack *contextPack) preferences() error {
	t := pack.t
	var prefs []core.Preference
	if err := pack.x.db.List(pack.x.ctx(), &prefs, store.Where(store.Live, store.Null("retired_at"))); err != nil {
		return err
	}
	var rules []string
	for _, pref := range prefs {
		if pref.ProjectID != "" && pref.ProjectID != t.ProjectID {
			continue
		}
		if len(pref.LabelIDs) > 0 && !slices.ContainsFunc(pref.LabelIDs, func(l string) bool { return slices.Contains(t.LabelIDs, l) }) {
			continue
		}
		rules = append(rules, pref.Body)
	}
	if len(rules) > 0 {
		pack.out["standing_preferences"] = rules
		pack.text.WriteString("=== standing preferences\n- " + strings.Join(rules, "\n- ") + "\n")
	}
	return nil
}

// recentDecisions adds earlier answers in the same project, which guide
// later work.
func (pack *contextPack) recentDecisions() error {
	x, ctx, t := pack.x, pack.x.ctx(), pack.t
	var picked []core.Decision
	if err := x.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: packDecisionsToCheck}); err != nil {
		return err
	}
	var recent []core.Decision
	for _, decision := range picked {
		if decision.TaskID == t.ID || len(recent) >= packRecentDecisions {
			continue
		}
		var asker core.Task // the task the decision was asked on
		err := x.db.Get(ctx, &asker, store.Eq("id", decision.TaskID))
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if asker.ProjectID == t.ProjectID {
			recent = append(recent, decision)
		}
	}
	views, err := x.decisionViews(recent)
	if err != nil {
		return err
	}
	if len(views) > 0 {
		pack.out["recent_decisions"] = views
		pack.text.WriteString("=== recent decisions in this project\n")
		for _, view := range views {
			answer := view.Outcome
			if view.PickedLabel != "" {
				answer = view.PickedLabel
			}
			fmt.Fprintf(&pack.text, "%s %q -> %s", view.Task, oneLine(view.Question, 100), answer)
			if view.Note != "" {
				pack.text.WriteString(": " + oneLine(view.Note, 160))
			}
			pack.text.WriteString("\n")
		}
	}
	return nil
}

// docs adds the docs this task mentions, or that mention it.
func (pack *contextPack) docs() error {
	x, ctx, t := pack.x, pack.x.ctx(), pack.t
	var refs []core.Ref
	if err := x.db.List(ctx, &refs, store.Where(store.Eq("from_scope_id", t.ID), store.Eq("to_type", "doc"))); err != nil {
		return err
	}
	var back []core.Ref
	if err := x.db.List(ctx, &back, store.Where(store.Eq("to_id", t.ID), store.Eq("from_scope_type", "doc"))); err != nil {
		return err
	}
	docIDs := map[string]bool{}
	for _, r := range refs {
		docIDs[r.ToID] = true
	}
	for _, r := range back {
		docIDs[r.FromScopeID] = true
	}
	var docs []map[string]any
	for docID := range docIDs {
		var doc core.Doc
		err := x.db.Get(ctx, &doc, store.Eq("id", docID), store.Live)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if engine.CanSeeDoc(doc, x.member.UserID) {
			docs = append(docs, map[string]any{"id": doc.ID, "title": doc.Title, "url": x.s.cfg.BaseURL + "/" + x.ws.Slug + "/docs/" + doc.ID})
		}
	}
	if len(docs) > 0 {
		pack.out["docs"] = docs
		pack.text.WriteString("=== linked docs\n")
		for _, doc := range docs {
			fmt.Fprintf(&pack.text, "%s  (doc %s)\n", doc["title"], doc["id"])
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
// those the caller may not see and those made in something since deleted.
func (x *c) namedRefs(refs []core.Ref) ([]namedRef, error) {
	out := []namedRef{}
	ctx := x.ctx()
	for _, ref := range refs {
		named := namedRef{Ref: ref}
		switch ref.FromScopeType {
		case "doc":
			var doc core.Doc
			err := x.db.Get(ctx, &doc, store.Eq("id", ref.FromScopeID), store.Live)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !engine.CanSeeDoc(doc, x.member.UserID) || !x.canProject(doc.ProjectID) {
				continue
			}
			named.Title = doc.Title
		case "task":
			var t core.Task
			err := x.db.Get(ctx, &t, store.Eq("id", ref.FromScopeID), store.Live)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !x.canProject(t.ProjectID) {
				continue
			}
			named.Title, named.Key = t.Title, t.Key
		}
		out = append(out, named)
	}
	return out, nil
}
