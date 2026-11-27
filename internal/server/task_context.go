// The context pack: one task with what surrounds it, for an agent about to work on it.

package server

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowTaskContext is the context pack: one call with everything an agent needs to
// work on a task.
func (s *Server) handleShowTaskContext(x *c) error {
	t, err := x.taskByRef(x.ctx(), x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	pack, err := x.contextPack(x.ctx(), t, x.maxChars())
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(x.namePages(x.ctx(), pack.text.String()))
	}
	return x.ok(pack.out)
}

// contextPack builds a task's context pack: the task in full, then what
// surrounds it. maxChars is where the task's own long text is cut (see
// buildTaskDetail).
func (who *viewer) contextPack(ctx context.Context, t core.Task, maxChars int) (*contextPack, error) {
	detail, err := who.buildTaskDetail(ctx, t, maxChars)
	if err != nil {
		return nil, err
	}
	pack := &contextPack{who: who, ctx: ctx, t: t, detail: detail, out: map[string]any{"task": detail}}
	pack.text.WriteString(detail.text())
	for _, part := range []func() error{pack.parents, pack.epic, pack.preferences, pack.recentDecisions, pack.docs} {
		if err := part(); err != nil {
			return nil, err
		}
	}
	return pack, nil
}

// contextPack is one task's context pack in the making, in both its forms:
// each part adds to the answer and to the text. It is one run of work, made
// and finished inside viewer.contextPack, which is why it holds a ctx.
type contextPack struct {
	who    *viewer
	ctx    context.Context
	t      core.Task
	detail taskDetail
	out    map[string]any
	text   strings.Builder
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
	who, ctx := pack.who, pack.ctx
	var parents []taskView
	for cur, depth := pack.t.ParentID, 0; cur != "" && depth < packParentDepth; depth++ {
		var up core.Task
		there, err := store.Find(ctx, who.db, &up, store.Eq("id", cur))
		if err != nil {
			return err
		}
		if !there {
			break
		}
		views, err := who.detailedTaskViews(ctx, []core.Task{up})
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
	names, err := pack.who.names(pack.ctx)
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
	if err := pack.who.db.List(pack.ctx, &prefs, store.Where(store.Live, store.Null("retired_at"))); err != nil {
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
	who, ctx, t := pack.who, pack.ctx, pack.t
	var picked []core.Decision
	if err := who.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.In("state", []string{core.StatePicked, core.StateSentBack}), store.Live}, Order: "-updated_seq", Limit: packDecisionsToCheck}); err != nil {
		return err
	}
	var recent []core.Decision
	for _, decision := range picked {
		if decision.TaskID == t.ID || len(recent) >= packRecentDecisions {
			continue
		}
		var asker core.Task // the task the decision was asked on
		there, err := store.Find(ctx, who.db, &asker, store.Eq("id", decision.TaskID))
		if err != nil {
			return err
		}
		if !there {
			continue
		}
		if asker.ProjectID == t.ProjectID {
			recent = append(recent, decision)
		}
	}
	views, err := who.decisionViews(ctx, recent)
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

// docs adds the pages the task and a page point at each other through
// (taskDetail.Pages): the linked docs.
func (pack *contextPack) docs() error {
	pages := pack.detail.Pages
	if len(pages) > 0 {
		pack.out["docs"] = pages
		pack.text.WriteString("=== linked docs\n")
		for _, page := range pages {
			fmt.Fprintf(&pack.text, "%s  (doc %s)\n", page.Title, page.ID)
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

// seenMentioned keeps, of mentions, those whose mentioned end the viewer
// may see: a task of a project it may read, a decision on one, a page it
// may see. A member is seen by everyone; what cannot be read, or is of a
// kind this does not know, is not seen. (Where a mention was made is
// namedRefs' to decide.)
func (who *viewer) seenMentioned(ctx context.Context, refs []core.Ref) []core.Ref {
	mayRead := who.readableTasks(ctx)
	return keep(refs, func(ref core.Ref) bool {
		switch ref.ToType {
		case "member":
			return true
		case "task":
			return !who.limited() || mayRead(ref.ToID)
		case "decision":
			var decision core.Decision
			return !who.limited() || who.db.Get(ctx, &decision, store.Eq("id", ref.ToID)) == nil && mayRead(decision.TaskID)
		case "doc":
			var page core.Doc
			return who.db.Get(ctx, &page, store.Eq("id", ref.ToID)) == nil && who.canSeeDoc(page)
		}
		return false
	})
}

// namedRefs gives each mention the name of where it was made, leaving out
// those the caller may not see and those made in something since deleted.
func (who *viewer) namedRefs(ctx context.Context, refs []core.Ref) ([]namedRef, error) {
	out := []namedRef{}
	for _, ref := range refs {
		named := namedRef{Ref: ref}
		switch ref.FromScopeType {
		case "doc":
			var doc core.Doc
			there, err := store.Find(ctx, who.db, &doc, store.Eq("id", ref.FromScopeID), store.Live)
			if err != nil {
				return nil, err
			}
			if !there {
				continue
			}
			if !who.canSeeDoc(doc) {
				continue
			}
			named.Title = doc.Title
		case "task":
			var t core.Task
			there, err := store.Find(ctx, who.db, &t, store.Eq("id", ref.FromScopeID), store.Live)
			if err != nil {
				return nil, err
			}
			if !there {
				continue
			}
			if !who.canProject(t.ProjectID) {
				continue
			}
			named.Title, named.Key = t.Title, t.Key
		}
		out = append(out, named)
	}
	return out, nil
}
