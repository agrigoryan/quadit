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
// first. A quiet change (history being imported) notifies nobody.
func (c *cx) notify(userID, typ string, n core.Notification) error {
	if userID == "" || (userID == c.actor.UserID && !c.selfNotify) || c.quiet {
		return nil
	}
	key := userID + "|" + n.TaskID + n.DocID
	if c.notified[key] {
		return nil
	}
	var m core.Member
	if ok, err := found(c.tx.Get(c.ctx, &m, store.Eq("user_id", userID), store.Null("removed_at"))); !ok {
		return err // nil when they are not a member any more: nobody to tell
	}
	c.notified[key] = true
	seq := c.tx.NextSeq()
	n.ID, n.WorkspaceID, n.UserID, n.Seq, n.Type, n.ActorID, n.CreatedAt = id.New(), c.ws, userID, seq, typ, c.actor.UserID, c.at
	n.Snippet = snippet(n.Snippet, 200)
	if err := c.tx.Insert(c.ctx, n); err != nil {
		return err
	}
	where := inWorkspace(c.ws)
	if n.TaskID != "" {
		where = place{scopeType: "task", scopeID: n.TaskID}
	} else if n.DocID != "" {
		where = place{scopeType: "doc", scopeID: n.DocID}
	}
	return c.emit(event{seq: seq, typ: "notification.created", entity: "notification", entityID: n.ID, place: where, audience: userID, data: map[string]any{"row": n}})
}

// about is what in a task a notification is about: a comment, a decision,
// or the task itself, with the text to show from it.
type about struct {
	entity, id, text string
}

// notifyTask notifies about something in a task.
func (c *cx) notifyTask(userID, typ string, t core.Task, what about) error {
	return c.notify(userID, typ, core.Notification{TaskID: t.ID, EntityType: what.entity, EntityID: what.id, Title: t.Key + " " + t.Title, Snippet: what.text})
}

// notifyWatchers notifies everyone watching a task.
func (c *cx) notifyWatchers(t core.Task, typ string, what about) error {
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
		if err := c.notifyTask(w.UserID, typ, t, what); err != nil {
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
	// A decision is named by its id ("decision:<id>", or a link to it) or by
	// its task and number ("SVA-7#2").
	decisionRefRE = regexp.MustCompile(`(?:decision:|/decisions?/|#decision-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)
	decisionNthRE = regexp.MustCompile(`\b([A-Z][A-Z0-9]{1,9}-\d+)#(\d+)\b`)
	// A page is also named by its title in double brackets: [[Art guide]].
	wikiRefRE = regexp.MustCompile(`\[\[([^\[\]\n]{1,200})\]\]`)
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
	l := &linker{c: c, from: core.Ref{WorkspaceID: c.ws, FromType: fromType, FromID: fromID, FromScopeType: scopeType, FromScopeID: scopeID},
		had: map[string]bool{}, want: map[string]core.Ref{}}
	for _, r := range old {
		l.had[r.ToID] = true
	}
	for _, step := range []func(string) error{l.members, l.tasks, l.docs, l.decisions, l.numberedDecisions, l.wikiLinks} {
		if err := step(text); err != nil {
			return nil, err
		}
	}
	if err := l.save(old); err != nil {
		return nil, err
	}
	return l.fresh, nil
}

// linker is one run of link: what a text mentions, found kind by kind.
type linker struct {
	c     *cx
	from  core.Ref            // the mentioning side, the same for every ref
	had   map[string]bool     // ids the text mentioned before
	want  map[string]core.Ref // what it mentions now, by id
	fresh []core.Member       // members mentioned now and not before
}

// add records a mention of toID, unless it is the text's own subject.
func (l *linker) add(toType, toID string) {
	if toID != l.from.FromID && toID != l.from.FromScopeID {
		r := l.from
		r.ToType, r.ToID = toType, toID
		l.want[toID] = r
	}
}

// members finds @handles of current members.
func (l *linker) members(text string) error {
	for _, m := range mentionRE.FindAllStringSubmatch(text, -1) {
		var mem core.Member
		ok, err := found(l.c.tx.Get(l.c.ctx, &mem, store.Eq("handle", m[2]), store.Null("removed_at")))
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if _, dup := l.want[mem.UserID]; !dup && !l.had[mem.UserID] {
			l.fresh = append(l.fresh, mem)
		}
		l.add("member", mem.UserID)
	}
	return nil
}

// tasks finds task keys (SVA-12).
func (l *linker) tasks(text string) error {
	for _, loc := range keyRE.FindAllStringSubmatchIndex(text, -1) {
		if rest := text[loc[1]:]; len(rest) > 1 && rest[0] == '#' && rest[1] >= '0' && rest[1] <= '9' {
			continue // "SVA-7#2" names a decision, taken in numberedDecisions
		}
		var t core.Task
		ok, err := found(l.c.tx.Get(l.c.ctx, &t, store.Eq("key", text[loc[2]:loc[3]])))
		if err != nil {
			return err
		}
		if ok {
			l.add("task", t.ID)
		}
	}
	return nil
}

// docs finds links to pages by id.
func (l *linker) docs(text string) error {
	for _, m := range docRefRE.FindAllStringSubmatch(text, -1) {
		var d core.Doc
		ok, err := found(l.c.tx.Get(l.c.ctx, &d, store.Eq("id", m[1])))
		if err != nil {
			return err
		}
		if ok {
			l.add("doc", d.ID)
		}
	}
	return nil
}

// decisions finds links to decisions by id.
func (l *linker) decisions(text string) error {
	for _, m := range decisionRefRE.FindAllStringSubmatch(text, -1) {
		var d core.Decision
		ok, err := found(l.c.tx.Get(l.c.ctx, &d, store.Eq("id", m[1]), store.Live))
		if err != nil {
			return err
		}
		if ok {
			l.add("decision", d.ID)
		}
	}
	return nil
}

// numberedDecisions finds decisions named by their task and number (SVA-7#2).
func (l *linker) numberedDecisions(text string) error {
	for _, m := range decisionNthRE.FindAllStringSubmatch(text, -1) {
		decisionID, err := l.c.decisionOnTask(m[1] + "#" + m[2])
		if isRefusal(err) {
			continue // names no decision
		}
		if err != nil {
			return err
		}
		l.add("decision", decisionID)
	}
	return nil
}

// wikiLinks finds pages named by their title in double brackets, when the
// title names exactly one page.
func (l *linker) wikiLinks(text string) error {
	for _, m := range wikiRefRE.FindAllStringSubmatch(text, -1) {
		title := strings.TrimSpace(m[1])
		var ds []core.Doc
		if err := l.c.tx.List(l.c.ctx, &ds, store.Q{Where: []store.Cond{store.Eq("title", title), store.Live}, Limit: 2}); err != nil {
			return err
		}
		if len(ds) == 0 {
			// Written in another case than the page's title.
			var all []core.Doc
			if err := l.c.tx.List(l.c.ctx, &all, store.Q{Where: []store.Cond{store.Live, store.Ne("kind", core.DocRow)}, Limit: 5000}); err != nil {
				return err
			}
			for _, d := range all {
				if strings.EqualFold(d.Title, title) {
					ds = append(ds, d)
				}
			}
		}
		if len(ds) == 1 {
			l.add("doc", ds[0].ID)
		}
	}
	return nil
}

// save deletes the refs the text no longer makes and inserts the new ones.
func (l *linker) save(old []core.Ref) error {
	for _, r := range old {
		if _, keep := l.want[r.ToID]; !keep {
			if _, err := l.c.tx.Delete(l.c.ctx, "refs", store.Eq("from_id", l.from.FromID), store.Eq("to_id", r.ToID)); err != nil {
				return err
			}
		}
	}
	for toID, r := range l.want {
		if !l.had[toID] {
			if err := l.c.tx.Insert(l.c.ctx, r); err != nil {
				return err
			}
		}
	}
	return nil
}

// index puts text in the full-text index.
func (c *cx) index(entry store.SearchDoc) error {
	return c.tx.Index(c.ctx, entry)
}
