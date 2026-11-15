package engine

import (
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
	Body string `json:"body"`
	// What the comment is about, when it is not the task or doc as a whole.
	Decision string `json:"decision"`
	Option   string `json:"option"`
	Block    string `json:"block"`
	Parent   string `json:"parent"` // the comment this replies to
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
		kind = "comment"
		if a.Evidence != nil {
			kind = "result"
		}
	}
	if kind != "comment" && kind != "result" {
		return "", oneOf("kind", "kind", a.Kind, []string{"comment", "result"})
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
			a.Block = parent.SubjectID
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
	data := map[string]any{"row": cm, "key": t.Key}
	if len(atts) > 0 {
		data["attachments"] = atts
	}
	c.ref, c.key = cm.ID, t.Key
	if err := c.emit(event{seq: seq, typ: "comment.created", entity: "comment", entityID: cm.ID, place: inTask(t), data: data}); err != nil {
		return err
	}
	if err := c.commentReaches(cm, t); err != nil {
		return err
	}
	note := core.NoteComment
	if cm.Kind == "result" {
		note = core.NoteResult
	}
	if err := c.handOn(cm, t, a, note); err != nil {
		return err
	}
	if err := c.notifyWatchers(t, note, about{entity: "comment", id: cm.ID, text: cm.Body}); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "comment", EntityID: cm.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: t.Key + " " + t.Title, Body: cm.Body})
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
		d, err := loadLive[core.Decision](c, "decision", "decision", a.Decision)
		if err != nil {
			return core.Task{}, err
		}
		if a.Task == "" {
			a.Task = d.TaskID
		}
		if cm.SubjectType == "" {
			cm.SubjectType, cm.SubjectID = "decision", d.ID
		}
		if t, err := c.task("task", a.Task); err != nil {
			return core.Task{}, err
		} else if t.ID != d.TaskID {
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
	if cm.ParentID != "" {
		var parent core.Comment
		ok, err := found(c.tx.Get(c.ctx, &parent, store.Eq("id", cm.ParentID)))
		if err != nil {
			return err
		}
		if ok {
			if err := c.notifyTask(parent.AuthorID, core.NoteReplied, t, about{entity: "comment", id: cm.ID, text: cm.Body}); err != nil {
				return err
			}
		}
	}
	return nil
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
		if handTo, err = c.optMember("waiting_on", a.WaitingOn.V); err != nil {
			return err
		}
	case a.WaitingOn.Set:
		if err := c.setWaitingOn(t, "", ""); err != nil {
			return err
		}
	case cm.Kind == "result":
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

// docComment adds a comment to a doc or one of its blocks.
func (c *cx) docComment(cm core.Comment, a commentCreateArgs) error {
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
	d, err := c.doc("doc", a.Doc)
	if err != nil {
		return err
	}
	if cm.SubjectType == "" {
		cm.SubjectType, cm.SubjectID = "doc", d.ID
	}
	cm.DocID = d.ID
	seq := c.tx.NextSeq()
	cm.CreatedSeq, cm.UpdatedSeq = seq, seq
	if err := c.tx.Insert(c.ctx, cm); err != nil {
		return alreadyInUse(err, "id", cm.ID)
	}
	c.ref = cm.ID
	if err := c.emit(event{seq: seq, typ: "comment.created", entity: "comment", entityID: cm.ID, place: inDoc(d), audience: d.OwnerID, data: map[string]any{"row": cm}}); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "doc", d.ID); err != nil {
		return err
	}
	mentioned, err := c.link("comment", cm.ID, "doc", d.ID, cm.Body)
	if err != nil {
		return err
	}
	n := core.Notification{DocID: d.ID, EntityType: "comment", EntityID: cm.ID, Title: d.Title, Snippet: cm.Body}
	for _, m := range mentioned {
		if err := c.notify(m.UserID, core.NoteMentioned, n); err != nil {
			return err
		}
	}
	if cm.ParentID != "" {
		var parent core.Comment
		ok, err := found(c.tx.Get(c.ctx, &parent, store.Eq("id", cm.ParentID)))
		if err != nil {
			return err
		}
		if ok {
			if err := c.notify(parent.AuthorID, core.NoteReplied, n); err != nil {
				return err
			}
		}
	}
	var ws []core.Watcher
	if err := c.tx.List(c.ctx, &ws, store.Where(store.Eq("subject_id", d.ID))); err != nil {
		return err
	}
	for _, w := range ws {
		if err := c.notify(w.UserID, core.NoteComment, n); err != nil {
			return err
		}
	}
	return c.index(store.SearchDoc{Kind: "comment", EntityID: cm.ID, ScopeType: "doc", ScopeID: d.ID, ProjectID: d.ProjectID, AudienceID: d.OwnerID, Title: d.Title, Body: cm.Body})
}

// commentPlace returns where a comment's events belong, and the key of its
// task when it is on one.
func (c *cx) commentPlace(cm core.Comment) (where place, key string, err error) {
	if cm.TaskID != "" {
		var t core.Task
		if err = c.tx.Get(c.ctx, &t, store.Eq("id", cm.TaskID)); err != nil {
			return place{}, "", err
		}
		return inTask(t), t.Key, nil
	}
	return place{scopeType: "doc", scopeID: cm.DocID}, "", nil
}

type commentUpdateArgs struct {
	ID       string      `json:"id"`
	Body     Opt[string] `json:"body"`
	Resolved Opt[bool]   `json:"resolved"`
}

func commentUpdate(c *cx, a commentUpdateArgs) error {
	cm, err := loadLive[core.Comment](c, "comment", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if a.Body.Set {
		if cm.AuthorID != c.actor.UserID {
			return forbidden("only its author can edit a comment")
		}
		if strings.TrimSpace(a.Body.V) == "" {
			return invalid("body", "a comment needs text; delete it instead")
		}
		p.setText("body", a.Body, &cm.Body)
		if !p.empty() {
			p.set["edited_at"] = c.at
			p.changes["edited_at"] = core.FieldChange{From: zeroNil(cm.EditedAt), To: c.at}
		}
	}
	if a.Resolved.Set {
		if a.Resolved.V && cm.ResolvedAt == 0 {
			p.put("resolved_at", int64(0), c.at)
		} else if !a.Resolved.V && cm.ResolvedAt != 0 {
			p.put("resolved_at", cm.ResolvedAt, int64(0))
		}
	}
	where, key, err := c.commentPlace(cm)
	if err != nil {
		return err
	}
	if err := c.save(p, target{table: "comments", entity: "comment", id: cm.ID, place: where, extra: map[string]any{"key": key}}); err != nil {
		return err
	}
	if _, ok := p.set["body"]; ok {
		if _, err := c.link("comment", cm.ID, where.scopeType, where.scopeID, cm.Body); err != nil {
			return err
		}
	}
	return nil
}

func commentDelete(c *cx, a idArgs) error {
	cm, err := loadLive[core.Comment](c, "comment", "id", a.ID)
	if err != nil {
		return err
	}
	if cm.AuthorID != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only its author, or an admin, can delete a comment")
	}
	where, key, err := c.commentPlace(cm)
	if err != nil {
		return err
	}
	if err := c.tx.Unindex(c.ctx, cm.ID); err != nil {
		return err
	}
	return c.trash(target{table: "comments", entity: "comment", id: cm.ID, place: where, extra: map[string]any{"key": key}})
}
