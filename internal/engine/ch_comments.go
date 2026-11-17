// comment.*: comments on tasks and pages.

package engine

import (
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("comment.create", core.RoleMember, commentCreate)
	register("comment.update", core.RoleMember, commentUpdate)
	register("comment.delete", core.RoleMember, commentDelete)
}

type commentCreateArgs struct {
	ID   string `json:"id"`
	Task string `json:"task"`
	Doc  string `json:"doc"`
	Body string `json:"body" quadit:"required,handler"`
	// What the comment is about, when it is not the task or doc as a whole.
	Decision string `json:"decision"`
	Option   string `json:"option"`
	Block    string `json:"block"`
	Parent   string `json:"parent"` // the comment this replies to
	// A thread on words of a page: the words (quote) in block, and where
	// they are: start and end, in characters of the block's text (a
	// mention counting as its @handle), end in end_block when they run on
	// past block. With quote alone they are found in the block; occurrence
	// (1 for the first) says which when they are there more than once.
	Quote      string   `json:"quote"`
	Start      Opt[int] `json:"start"`
	End        Opt[int] `json:"end"`
	EndBlock   string   `json:"end_block"`
	Occurrence int      `json:"occurrence"`
	// Kind "result" is what an agent delivers: the body says what was done
	// and evidence says how it was checked.
	Kind        string         `json:"kind"`
	Evidence    *core.Evidence `json:"evidence"`
	Attachments []attachArgs   `json:"attachments"`
	// WaitingOn hands the task to someone in the same change. A result with
	// no waiting_on goes back to whoever answered the last decision.
	WaitingOn     Opt[string] `json:"waiting_on"`
	WaitingOnNote string      `json:"waiting_on_note"`
}

// commentCreate adds a comment: to a page or one of its blocks, or to a
// task or a decision or option on it.
func commentCreate(c *cx, a commentCreateArgs) error {
	cid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Body) == "" {
		return invalid("body", "a comment needs text")
	}
	kind, err := commentKind(a)
	if err != nil {
		return err
	}
	cm := core.Comment{ID: cid, WorkspaceID: c.ws, Kind: kind, Evidence: a.Evidence, AuthorID: c.actor.UserID, Body: a.Body, CreatedAt: c.at}
	if a.Parent != "" {
		if err := c.replyTo(&cm, &a); err != nil {
			return err
		}
	}
	if a.Doc != "" || (a.Block != "" && a.Task == "") {
		return c.docComment(cm, a)
	}
	return c.taskComment(cm, a)
}

// commentKind is the kind of a new comment: the one given, or else a result
// when it comes with evidence and a plain comment when not.
func commentKind(a commentCreateArgs) (string, error) {
	kind := a.Kind
	if kind == "" {
		kind = core.CommentPlain
		if a.Evidence != nil {
			kind = core.CommentResult
		}
	}
	if kind != core.CommentPlain && kind != core.CommentResult {
		return "", oneOf("kind", "kind", a.Kind, []string{core.CommentPlain, core.CommentResult})
	}
	return kind, nil
}

// replyTo makes a comment a reply. It joins its parent's thread, and where
// the caller named nothing it is about what the parent is about.
func (c *cx) replyTo(cm *core.Comment, a *commentCreateArgs) error {
	parent, err := loadLive[core.Comment](c, "comment", "parent", a.Parent)
	if err != nil {
		return err
	}
	cm.ParentID = parent.ID
	if parent.ParentID != "" {
		cm.ParentID = parent.ParentID // threads are one level deep
	}
	if a.Task == "" && a.Doc == "" {
		a.Task, a.Doc = parent.TaskID, parent.DocID
	}
	if a.Decision == "" && a.Option == "" && a.Block == "" {
		switch parent.SubjectType {
		case "decision":
			a.Decision = parent.SubjectID
		case "decision_option":
			a.Option = parent.SubjectID
		case "doc_block":
			// The thread's block, even one taken out of the page since: a
			// thread outlives its block, and only a new one needs it there.
			cm.SubjectType, cm.SubjectID = parent.SubjectType, parent.SubjectID
		}
	}
	return nil
}

// taskComment adds a comment to a task, or to a decision or an option on
// it, tells the people it concerns and hands the task on.
func (c *cx) taskComment(cm core.Comment, a commentCreateArgs) error {
	t, err := c.commentSubject(&cm, a)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	cm.CreatedSeq, cm.UpdatedSeq = seq, seq
	if err := c.tx.Insert(c.ctx, cm); err != nil {
		return alreadyInUse(err, "id", cm.ID)
	}
	var atts []core.Attachment
	for _, aa := range a.Attachments {
		at, err := c.attach(aa, "comment", cm.ID, t)
		if err != nil {
			return err
		}
		atts = append(atts, at)
	}
	// A comment is activity on its task: this is what lets "what is new on
	// my tasks" see it.
	if err := c.touchTask(t.ID, seq); err != nil {
		return err
	}
	data := core.EventData{Row: cm, Key: &t.Key, Attachments: atts}
	c.ref, c.key = cm.ID, t.Key
	if err := c.emit(event{seq: seq, typ: "comment.created", entity: "comment", entityID: cm.ID, place: inTask(t), data: data}); err != nil {
		return err
	}
	if err := c.commentReaches(cm, t); err != nil {
		return err
	}
	note := core.NoteComment
	if cm.Kind == core.CommentResult {
		note = core.NoteResult
	}
	if err := c.handOn(cm, t, a, note); err != nil {
		return err
	}
	if err := c.notifyWatchers(t, note, about{entity: "comment", id: cm.ID, text: cm.Body}); err != nil {
		return err
	}
	return c.index(taskCommentEntry(t, cm))
}

// commentSubject works out what a comment on a task is about: an option, a
// decision, or the task itself.
func (c *cx) commentSubject(cm *core.Comment, a commentCreateArgs) (core.Task, error) {
	// A comment on an option or a decision knows its task.
	if a.Option != "" {
		o, err := loadLive[core.Option](c, "option", "option", a.Option)
		if err != nil {
			return core.Task{}, err
		}
		cm.SubjectType, cm.SubjectID, a.Decision = "decision_option", o.ID, o.DecisionID
	}
	if a.Decision != "" {
		decision, err := loadLive[core.Decision](c, "decision", "decision", a.Decision)
		if err != nil {
			return core.Task{}, err
		}
		if a.Task == "" {
			a.Task = decision.TaskID
		}
		if cm.SubjectType == "" {
			cm.SubjectType, cm.SubjectID = "decision", decision.ID
		}
		if t, err := c.task("task", a.Task); err != nil {
			return core.Task{}, err
		} else if t.ID != decision.TaskID {
			return core.Task{}, invalid("decision", "that decision belongs to another task")
		}
	}
	t, err := c.task("task", a.Task)
	if err != nil {
		return core.Task{}, err
	}
	if cm.SubjectType == "" {
		cm.SubjectType, cm.SubjectID = "task", t.ID
	}
	cm.TaskID = t.ID
	return t, nil
}

// commentReaches makes the author a follower of the task, and tells those
// the comment mentions and the one it replies to.
func (c *cx) commentReaches(cm core.Comment, t core.Task) error {
	if err := c.watch(c.actor.UserID, "task", t.ID); err != nil {
		return err
	}
	mentioned, err := c.link("comment", cm.ID, "task", t.ID, cm.Body)
	if err != nil {
		return err
	}
	for _, m := range mentioned {
		if err := c.watch(m.UserID, "task", t.ID); err != nil {
			return err
		}
		if err := c.notifyTask(m.UserID, core.NoteMentioned, t, about{entity: "comment", id: cm.ID, text: cm.Body}); err != nil {
			return err
		}
	}
	people, err := c.threadPeople(cm)
	if err != nil {
		return err
	}
	for _, p := range people {
		if err := c.notifyTask(p, core.NoteReplied, t, about{entity: "comment", id: cm.ID, text: cm.Body}); err != nil {
			return err
		}
	}
	return nil
}

// threadPeople are those a reply answers: whoever wrote in its thread
// before it, the first comment's author and each earlier reply's, once
// each. A comment that starts a thread answers nobody.
func (c *cx) threadPeople(cm core.Comment) ([]string, error) {
	if cm.ParentID == "" {
		return nil, nil
	}
	var earlier []core.Comment
	if err := c.tx.List(c.ctx, &earlier, store.Q{Where: []store.Cond{store.Either(store.Eq("id", cm.ParentID), store.Eq("parent_id", cm.ParentID)),
		store.Ne("id", cm.ID), store.Live}, Order: "created_seq"}); err != nil {
		return nil, err
	}
	var people []string
	for _, e := range earlier {
		if !slices.Contains(people, e.AuthorID) {
			people = append(people, e.AuthorID)
		}
	}
	return people, nil
}

// handOn hands the task on with a comment: where the caller said, or for a
// result, back to whoever answered last.
func (c *cx) handOn(cm core.Comment, t core.Task, a commentCreateArgs, note string) error {
	var err error
	handTo, handNote := "", a.WaitingOnNote
	switch {
	case a.WaitingOn.Set && isOutside(a.WaitingOn.V):
		// The next move is nobody's here: the note says what it waits for.
		if err := checkOutsideNote(a.WaitingOnNote); err != nil {
			return err
		}
		if err := c.setWaitingOutside(t, a.WaitingOnNote); err != nil {
			return err
		}
	case a.WaitingOn.Set && !a.WaitingOn.Null && a.WaitingOn.V != "":
		if handTo, err = c.personOnTask("waiting_on", a.WaitingOn.V, t); err != nil {
			return err
		}
	case a.WaitingOn.Set:
		if err := c.setWaitingOn(t, "", ""); err != nil {
			return err
		}
	case cm.Kind == core.CommentResult:
		var ds []core.Decision
		if err := c.tx.List(c.ctx, &ds, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.NotNull("decided_by"), store.Live},
			Order: "-updated_seq", Limit: 1}); err != nil {
			return err
		}
		if len(ds) > 0 && ds[0].DecidedBy != c.actor.UserID {
			handTo = ds[0].DecidedBy
		} else if t.CreatedBy != c.actor.UserID {
			handTo = t.CreatedBy
		}
		if handNote == "" {
			handNote = "review the result"
		}
	}
	if handTo != "" {
		if err := c.notifyTask(handTo, note, t, about{entity: "comment", id: cm.ID, text: cm.Body}); err != nil {
			return err
		}
		if err := c.setWaitingOn(t, handTo, handNote); err != nil {
			return err
		}
	}
	return nil
}

// docComment adds a comment to a doc, one of its blocks or words of it,
// with its files. A thread on words puts its marker on them in the same
// change: only commenting is asked of the author, not editing the page.
func (c *cx) docComment(cm core.Comment, a commentCreateArgs) error {
	onWords := a.Quote != "" || a.Start.Set || a.Occurrence != 0
	if onWords && cm.ParentID != "" {
		return invalid("quote", "a reply is on its thread's words; start a thread of its own on other words")
	}
	if onWords && a.Block == "" {
		return invalid("block", "give the block the words are in")
	}
	if a.Block != "" {
		b, err := loadLive[core.Block](c, "block", "block", a.Block)
		if err != nil {
			return err
		}
		cm.SubjectType, cm.SubjectID = "doc_block", b.ID
		if a.Doc == "" {
			a.Doc = b.DocID
		}
	}
	doc, err := c.loadDoc("doc", a.Doc)
	if err != nil {
		return err
	}
	if cm.SubjectType == "" {
		cm.SubjectType, cm.SubjectID = "doc", doc.ID
	}
	var marks *editor
	if onWords {
		rows, err := LoadBlocks(cxLister{c}, doc.ID)
		if err != nil {
			return err
		}
		marks = newEditor(c, doc, rows)
		parts, quote, err := c.selection(marks, a)
		if err != nil {
			return err
		}
		if err := markSelection(marks, parts, cm.ID); err != nil {
			return err
		}
		cm.Quote, cm.SubjectID = quote, parts[0].block
	}
	cm.DocID = doc.ID
	seq := c.tx.NextSeq()
	cm.CreatedSeq, cm.UpdatedSeq = seq, seq
	if err := c.tx.Insert(c.ctx, cm); err != nil {
		return alreadyInUse(err, "id", cm.ID)
	}
	// Files given with the comment are on the comment, and are seen where
	// the page is: their rows say no task, and the comment's event, which
	// carries them, goes to those who may see the page.
	var atts []core.Attachment
	for _, aa := range a.Attachments {
		at, err := c.attach(aa, "comment", cm.ID, core.Task{})
		if err != nil {
			return err
		}
		atts = append(atts, at)
	}
	c.ref = cm.ID
	if err := c.emit(event{seq: seq, typ: "comment.created", entity: "comment", entityID: cm.ID, place: inDoc(doc), audience: doc.OwnerID, data: core.EventData{Row: cm, Attachments: atts}}); err != nil {
		return err
	}
	if marks != nil {
		if err := c.writeMarks(doc, marks); err != nil {
			return err
		}
	}
	if err := c.watch(c.actor.UserID, "doc", doc.ID); err != nil {
		return err
	}
	mentioned, err := c.link("comment", cm.ID, "doc", doc.ID, cm.Body)
	if err != nil {
		return err
	}
	n := core.Notification{DocID: doc.ID, EntityType: "comment", EntityID: cm.ID, Title: doc.Title, Snippet: cm.Body}
	for _, m := range mentioned {
		if err := c.notify(m.UserID, core.NoteMentioned, n); err != nil {
			return err
		}
	}
	people, err := c.threadPeople(cm)
	if err != nil {
		return err
	}
	for _, p := range people {
		if err := c.notify(p, core.NoteReplied, n); err != nil {
			return err
		}
	}
	var ws []core.Watcher
	if err := c.tx.List(c.ctx, &ws, store.Where(store.Eq("subject_id", doc.ID))); err != nil {
		return err
	}
	for _, w := range ws {
		if err := c.notify(w.UserID, core.NoteComment, n); err != nil {
			return err
		}
	}
	return c.index(docCommentEntry(doc, cm))
}

// indexComment puts a comment as it is now into search, under its task or
// its page.
func (c *cx) indexComment(cm core.Comment) error {
	if cm.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", cm.TaskID)); err != nil {
			return err
		}
		return c.index(taskCommentEntry(t, cm))
	}
	var d core.Doc
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", cm.DocID)); err != nil {
		return err
	}
	return c.index(docCommentEntry(d, cm))
}

// taskCommentEntry is how search knows a comment on a task: by the task's
// key and title.
func taskCommentEntry(t core.Task, cm core.Comment) store.SearchDoc {
	return store.SearchDoc{Kind: "comment", EntityID: cm.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: t.Key + " " + t.Title, Body: cm.Body}
}

// docCommentEntry is how search knows a comment on a page: by the page's
// title, and only to those who may see the page.
func docCommentEntry(doc core.Doc, cm core.Comment) store.SearchDoc {
	return store.SearchDoc{Kind: "comment", EntityID: cm.ID, ScopeType: "doc", ScopeID: doc.ID, ProjectID: doc.ProjectID, AudienceID: doc.OwnerID, Title: doc.Title, Body: cm.Body}
}

// commentTarget names a comment's row for a save or a trash: its events
// belong to its task, with the task's key, or to its page, and then only
// those who may see the page see them.
func (c *cx) commentTarget(cm core.Comment) (target, error) {
	row := target{table: "comments", entity: "comment", id: cm.ID}
	if cm.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", cm.TaskID)); err != nil {
			return row, err
		}
		row.place, row.extra.Key = inTask(t), &t.Key
		return row, nil
	}
	var d core.Doc
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", cm.DocID)); err != nil {
		return row, err
	}
	key := ""
	row.place, row.audience, row.extra.Key = inDoc(d), docAudience(d), &key
	return row, nil
}

type commentUpdateArgs struct {
	ID       string      `json:"id" quadit:"required"`
	Body     Opt[string] `json:"body"`
	Resolved Opt[bool]   `json:"resolved"`
}

// commentUpdate edits a comment's text, by its author, or resolves its
// thread or opens it again. A thread is resolved as a whole, and its first
// comment carries that: asked through a reply, it is done to the first.
func commentUpdate(c *cx, a commentUpdateArgs) error {
	cm, err := loadLive[core.Comment](c, "comment", "id", a.ID)
	if err != nil {
		return err
	}
	if a.Body.Set {
		if cm.AuthorID != c.actor.UserID {
			return forbidden("only its author can edit a comment")
		}
		if strings.TrimSpace(a.Body.V) == "" {
			return invalid("body", "a comment needs text; delete it instead")
		}
	}
	row, err := c.commentTarget(cm)
	if err != nil {
		return err
	}
	if a.Resolved.Set {
		first := cm
		if cm.ParentID != "" {
			if first, err = loadLive[core.Comment](c, "comment", "id", cm.ParentID); err != nil {
				return err
			}
		}
		p := newPatch()
		p.setStamp("resolved_at", a.Resolved, first.ResolvedAt, c.at)
		thread := row
		thread.id = first.ID
		if err := c.save(p, thread); err != nil {
			return err
		}
	}
	if a.Body.Set {
		p := newPatch()
		p.setText("body", a.Body, &cm.Body)
		if !p.empty() {
			p.set["edited_at"] = c.at
			p.changes["edited_at"] = core.FieldChange{From: nullIfEmpty(cm.EditedAt), To: c.at}
			if err := c.save(p, row); err != nil {
				return err
			}
			if _, err := c.link("comment", cm.ID, row.place.scopeType, row.place.scopeID, cm.Body); err != nil {
				return err
			}
			if err := c.indexComment(cm); err != nil {
				return err
			}
		}
	}
	c.ref = cm.ID
	return nil
}

// commentDelete moves a comment to the trash. The thread a first comment
// started goes on without it: its first reply heads it, resolved or not as
// the thread was, and the other replies answer that one.
func commentDelete(c *cx, a idArgs) error {
	cm, err := loadLive[core.Comment](c, "comment", "id", a.ID)
	if err != nil {
		return err
	}
	if cm.AuthorID != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only its author, or an admin, can delete a comment")
	}
	row, err := c.commentTarget(cm)
	if err != nil {
		return err
	}
	if err := c.tx.Unindex(c.ctx, cm.ID); err != nil {
		return err
	}
	if err := c.trash(row); err != nil {
		return err
	}
	if cm.ParentID != "" {
		return nil
	}
	var replies []core.Comment
	if err := c.tx.List(c.ctx, &replies, store.Q{Where: []store.Cond{store.Eq("parent_id", cm.ID), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	if cm.Quote != "" {
		// The thread's words keep its marker under its new head's id, or
		// lose it with the thread.
		heir := ""
		if len(replies) > 0 {
			heir = replies[0].ID
		}
		if err := c.rethread(cm, heir); err != nil {
			return err
		}
	}
	for i, reply := range replies {
		p := newPatch()
		if i == 0 {
			// The new head carries what the thread is on.
			p.put("parent_id", reply.ParentID, "")
			p.put("resolved_at", reply.ResolvedAt, cm.ResolvedAt)
			p.put("subject_type", reply.SubjectType, cm.SubjectType)
			p.put("subject_id", reply.SubjectID, cm.SubjectID)
			p.put("quote", reply.Quote, cm.Quote)
			p.put("detached_at", reply.DetachedAt, cm.DetachedAt)
		} else {
			p.put("parent_id", reply.ParentID, replies[0].ID)
		}
		moved := row
		moved.id = reply.ID
		if err := c.save(p, moved); err != nil {
			return err
		}
	}
	c.ref = cm.ID
	return nil
}
