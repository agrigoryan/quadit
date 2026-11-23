// The inbox, watchers, what a text mentions, and the search index.

package engine

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// notify puts an item in a member's inbox and tells only them, in the feed.
// The actor is never notified of their own change, and a member gets at most
// one item per change and subject: callers notify the most specific reason
// first. A quiet change (history being imported) notifies nobody, and a
// member is not told of a task or a page of a project they may not read.
func (c *cx) notify(userID, typ string, n core.Notification) error {
	if userID == "" || (userID == c.actor.UserID && !c.selfNotify) || c.quiet || c.noNews {
		return nil
	}
	key := userID + "|" + n.TaskID + n.DocID
	if c.notified[key] {
		return nil
	}
	var m core.Member
	if ok, err := store.Find(c.ctx, c.tx, &m, store.Eq("user_id", userID), store.Null("removed_at")); !ok {
		return err // nil when they are not a member any more: nobody to tell
	}
	// The item's event belongs to the project of the task or the page it is
	// about, so that a feed kept to other projects (a token made for them)
	// leaves it out.
	where := inWorkspace(c.ws)
	if n.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", n.TaskID)); err != nil {
			return err
		}
		where = inTask(t)
	} else if n.DocID != "" {
		var d core.Doc
		if err := c.tx.Get(c.ctx, &d, store.Eq("id", n.DocID)); err != nil {
			return err
		}
		where = inDoc(d)
	}
	if !m.Scope.MayRead(where.projectID) {
		return nil
	}
	c.notified[key] = true
	seq := c.tx.NextSeq()
	n.ID, n.WorkspaceID, n.UserID, n.Seq, n.Type, n.ActorID, n.CreatedAt = id.New(), c.ws, userID, seq, typ, c.actor.UserID, c.at
	n.Snippet = snippet(n.Snippet, 200)
	if err := c.tx.Insert(c.ctx, n); err != nil {
		return err
	}
	// Telling someone is not a write to the task or the page: the actor's
	// own limits are not asked of it (resource.release tells the next in
	// line, whose task may be of a project the actor does not have).
	was := c.system
	c.system = true
	err := c.emit(event{seq: seq, typ: "notification.created", entity: "notification", entityID: n.ID, place: where, audience: userID, data: core.EventData{Row: n}})
	c.system = was
	return err
}

// undoWindow is how long after a change its undo still takes its news back.
const undoWindow = 5 * time.Minute

// takeBackNews is for a change that undoes an earlier one (Change.Undoes).
// A mistake put right at once is news to nobody: when the earlier change
// was this member's own and no older than undoWindow, the inbox items it
// made that are still unread are removed (a push or a mail not yet sent
// for them is then never sent), and this change makes none. An undo that
// comes later, or of someone else's change, is a change like any other:
// what the first one said has been read or acted on by then.
func (c *cx) takeBackNews() error {
	if c.change.Undoes == "" {
		return nil
	}
	var undone core.AppliedChange
	found, err := store.Find(c.ctx, c.tx, &undone, store.Eq("id", c.change.Undoes))
	if err != nil || !found || undone.ActorID != c.actor.UserID || c.at-undone.CreatedAt > undoWindow.Milliseconds() {
		return err
	}
	c.noNews = true
	// The earlier change's events are the feed from its first position to its last.
	told, err := c.tx.Events(c.ctx, store.EventFilter{After: undone.FirstSeq - 1, Types: []string{"notification.created"},
		ActorID: c.actor.UserID, Limit: int(undone.LastSeq - undone.FirstSeq + 1)})
	if err != nil {
		return err
	}
	for _, ev := range told {
		if ev.Seq > undone.LastSeq || ev.ChangeID != undone.ID {
			continue
		}
		n, err := c.tx.Delete(c.ctx, "notifications", store.Eq("id", ev.EntityID), store.Null("read_at"), store.Null("archived_at"))
		if err != nil {
			return err
		}
		if n == 0 {
			continue // read or put away already: it stays as it is
		}
		// Like the item itself, its going is told to its owner alone, whatever the actor's own limits.
		was := c.system
		c.system = true
		err = c.emit(event{seq: c.tx.NextSeq(), typ: "notification.deleted", entity: "notification", entityID: ev.EntityID,
			place: place{scopeType: ev.ScopeType, scopeID: ev.ScopeID, projectID: ev.ProjectID}, audience: ev.AudienceID,
			data: core.EventData{ID: ev.EntityID, Gone: true}})
		c.system = was
		if err != nil {
			return err
		}
	}
	return nil
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

// watch makes a member a watcher of a task, epic, project, view or doc, for
// something they did or were given there. Only a person is made one so: an
// agent follows only what it chose to (watch.set), and hears of the rest
// when it is for it (a mention, a hand-off, a question), so that it is not
// woken for every later comment on a task it once touched.
func (c *cx) watch(userID, subjectType, subjectID string) error {
	if userID == "" {
		return nil
	}
	if agent, err := c.isAgent(userID); err != nil || agent {
		return err
	}
	return c.tx.Upsert(c.ctx, core.Watcher{WorkspaceID: c.ws, UserID: userID, SubjectType: subjectType, SubjectID: subjectID, CreatedAt: c.at},
		"subject_id", "user_id")
}

var markup = strings.NewReplacer("**", "", "__", "", "`", "", "~~", "", "# ", "", "> ", "", "- [ ] ", "", "- [x] ", "")

// snippet is the start of some text on one line, at most n characters (not
// bytes: a line of Chinese is as long as one of English), with its
// Markdown marks taken out, for showing in an inbox row or a notification.
func snippet(s string, n int) string {
	s = strings.Join(strings.Fields(markup.Replace(s)), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
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
		ok, err := store.Find(l.c.ctx, l.c.tx, &mem, store.Eq("handle", m[2]), store.Null("removed_at"))
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

// tasks links the tasks named by key (SVA-12) that exist; a key followed
// by #N names a decision, and is left to numberedDecisions.
func (l *linker) tasks(text string) error {
	for _, loc := range keyRE.FindAllStringSubmatchIndex(text, -1) {
		if rest := text[loc[1]:]; len(rest) > 1 && rest[0] == '#' && rest[1] >= '0' && rest[1] <= '9' {
			continue // "SVA-7#2" names a decision, taken in numberedDecisions
		}
		var t core.Task
		ok, err := store.Find(l.c.ctx, l.c.tx, &t, store.Eq("key", text[loc[2]:loc[3]]))
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
		var doc core.Doc
		ok, err := store.Find(l.c.ctx, l.c.tx, &doc, store.Eq("id", m[1]))
		if err != nil {
			return err
		}
		if ok {
			l.add("doc", doc.ID)
		}
	}
	return nil
}

// decisions finds links to decisions by id.
func (l *linker) decisions(text string) error {
	for _, m := range decisionRefRE.FindAllStringSubmatch(text, -1) {
		var decision core.Decision
		ok, err := store.Find(l.c.ctx, l.c.tx, &decision, store.Eq("id", m[1]), store.Live)
		if err != nil {
			return err
		}
		if ok {
			l.add("decision", decision.ID)
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
			// Written in another case than the page's title: every page is
			// compared, as SQLite's LOWER knows the case of ASCII only.
			var all []core.Doc
			if err := l.c.tx.List(l.c.ctx, &all, store.Where(store.Live, store.Ne("kind", core.DocRow))); err != nil {
				return err
			}
			for _, doc := range all {
				if strings.EqualFold(doc.Title, title) {
					ds = append(ds, doc)
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
