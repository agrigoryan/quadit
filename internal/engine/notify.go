package engine

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// notify puts an item in a member's inbox and tells only them, in the feed.
// The actor is never notified of their own change, and a member gets at most
// one item per change and subject: callers notify the most specific reason
// first.
func (c *cx) notify(userID, typ string, n core.Notification) error {
	if userID == "" || (userID == c.actor.UserID && !c.selfNotify) {
		return nil
	}
	key := userID + "|" + n.TaskID + n.DocID
	if c.notified[key] {
		return nil
	}
	var m core.Member
	if err := c.tx.Get(c.ctx, &m, store.Eq("user_id", userID), store.Null("removed_at")); err != nil {
		return nil // not a member any more: nobody to tell
	}
	c.notified[key] = true
	seq := c.tx.NextSeq()
	n.ID, n.WorkspaceID, n.UserID, n.Seq, n.Type, n.ActorID, n.CreatedAt = id.New(), c.ws, userID, seq, typ, c.actor.UserID, c.at
	n.Snippet = snippet(n.Snippet, 200)
	if err := c.tx.Insert(c.ctx, n); err != nil {
		return err
	}
	scopeType, scopeID := "workspace", c.ws
	if n.TaskID != "" {
		scopeType, scopeID = "task", n.TaskID
	} else if n.DocID != "" {
		scopeType, scopeID = "doc", n.DocID
	}
	return c.emitTo(userID, seq, "notification.created", "notification", n.ID, scopeType, scopeID, "", map[string]any{"row": n})
}

// notifyTask notifies about something in a task.
func (c *cx) notifyTask(userID, typ string, t core.Task, entityType, entityID, text string) error {
	return c.notify(userID, typ, core.Notification{TaskID: t.ID, EntityType: entityType, EntityID: entityID, Title: t.Key + " " + t.Title, Snippet: text})
}

// notifyWatchers notifies everyone watching a task, except those in skip.
func (c *cx) notifyWatchers(t core.Task, typ, entityType, entityID, text string) error {
	// Watching a task's epic or its project is watching the task.
	subjects := []string{t.ID, t.ProjectID}
	if t.EpicID != "" {
		subjects = append(subjects, t.EpicID)
	}
	var ws []core.Watcher
	if err := c.tx.List(c.ctx, &ws, store.Where(store.In("subject_id", subjects))); err != nil {
		return err
	}
	for _, w := range ws {
		if err := c.notifyTask(w.UserID, typ, t, entityType, entityID, text); err != nil {
			return err
		}
	}
	return nil
}

// watch makes a member a watcher of a task, epic, project, view or doc.
func (c *cx) watch(userID, subjectType, subjectID string) error {
	if userID == "" {
		return nil
	}
	return c.tx.Upsert(c.ctx, core.Watcher{WorkspaceID: c.ws, UserID: userID, SubjectType: subjectType, SubjectID: subjectID, CreatedAt: c.at},
		"subject_id", "user_id")
}

var markup = strings.NewReplacer("**", "", "__", "", "`", "", "~~", "", "# ", "", "> ", "", "- [ ] ", "", "- [x] ", "")

// snippet is the start of some text on one line, with its Markdown marks
// taken out, for showing in an inbox row or a notification.
func snippet(s string, n int) string {
	s = strings.Join(strings.Fields(markup.Replace(s)), " ")
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

var (
	mentionRE = regexp.MustCompile(`(^|[^A-Za-z0-9_@/])@([a-z0-9][a-z0-9_-]{1,31})`)
	keyRE     = regexp.MustCompile(`\b([A-Z][A-Z0-9]{1,9}-\d+)\b`)
	docRefRE  = regexp.MustCompile(`(?:doc:|/docs?/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)
)

// link records what a piece of text mentions (members by @handle, tasks by
// key, docs by link), replacing what the same text mentioned before. It
// returns the members mentioned now that were not mentioned before, who are
// the ones to notify.
func (c *cx) link(fromType, fromID, scopeType, scopeID, text string) ([]core.Member, error) {
	var old []core.Ref
	if err := c.tx.List(c.ctx, &old, store.Where(store.Eq("from_id", fromID))); err != nil {
		return nil, err
	}
	had := map[string]bool{}
	for _, r := range old {
		had[r.ToID] = true
	}
	want := map[string]core.Ref{}
	var fresh []core.Member
	add := func(toType, toID string) {
		if toID != fromID && toID != scopeID {
			want[toID] = core.Ref{WorkspaceID: c.ws, FromType: fromType, FromID: fromID, FromScopeType: scopeType, FromScopeID: scopeID, ToType: toType, ToID: toID}
		}
	}
	for _, m := range mentionRE.FindAllStringSubmatch(text, -1) {
		var mem core.Member
		if err := c.tx.Get(c.ctx, &mem, store.Eq("handle", m[2]), store.Null("removed_at")); err != nil {
			continue
		}
		if _, dup := want[mem.UserID]; !dup && !had[mem.UserID] {
			fresh = append(fresh, mem)
		}
		add("member", mem.UserID)
	}
	for _, m := range keyRE.FindAllStringSubmatch(text, -1) {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("key", m[1])); err == nil {
			add("task", t.ID)
		}
	}
	for _, m := range docRefRE.FindAllStringSubmatch(text, -1) {
		var d core.Doc
		if err := c.tx.Get(c.ctx, &d, store.Eq("id", m[1])); err == nil {
			add("doc", d.ID)
		}
	}
	for _, r := range old {
		if _, keep := want[r.ToID]; !keep {
			if _, err := c.tx.Delete(c.ctx, "refs", store.Eq("from_id", fromID), store.Eq("to_id", r.ToID)); err != nil {
				return nil, err
			}
		}
	}
	for toID, r := range want {
		if !had[toID] {
			if err := c.tx.Insert(c.ctx, r); err != nil {
				return nil, err
			}
		}
	}
	return fresh, nil
}

// index puts text in the full-text index.
func (c *cx) index(kind, entityID, scopeType, scopeID, projectID, audience, title, body string) error {
	return c.tx.Index(c.ctx, store.SearchDoc{Kind: kind, EntityID: entityID, ScopeType: scopeType, ScopeID: scopeID,
		ProjectID: projectID, AudienceID: audience, Title: title, Body: body})
}
