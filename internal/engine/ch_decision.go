package engine

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("comment.create", core.RoleMember, commentCreate)
	register("comment.update", core.RoleMember, commentUpdate)
	register("comment.delete", core.RoleMember, commentDelete)
	register("decision.open", core.RoleMember, decisionOpen)
	register("decision.update", core.RoleMember, decisionUpdate)
	register("decision.pick", core.RoleMember, decisionPick)
	register("decision.unclear", core.RoleMember, decisionUnclear)
	register("decision.delete", core.RoleMember, decisionDelete)
	register("decision.restore", core.RoleMember, decisionRestore)
	register("preference.create", core.RoleAdmin, preferenceCreate)
	register("preference.update", core.RoleAdmin, preferenceUpdate)
	register("preference.delete", core.RoleAdmin, preferenceDelete)
	register("attachment.add", core.RoleMember, attachmentAdd)
	register("attachment.remove", core.RoleMember, attachmentRemove)
	register("attachment.restore", core.RoleMember, attachmentRestore)
}

// ---- attachments ----

type attachArgs struct {
	ID      string `json:"id"`
	File    string `json:"file"`
	Role    string `json:"role"` // "", before, after
	Caption string `json:"caption"`
	// One of these says what the file is shown on.
	Task     string `json:"task"`
	Comment  string `json:"comment"`
	Decision string `json:"decision"`
	Option   string `json:"option"`
	Doc      string `json:"doc"`
}

// attach links an uploaded file to a subject. task may be zero for docs.
func (c *cx) attach(a attachArgs, subjectType, subjectID string, t core.Task) (core.Attachment, error) {
	var at core.Attachment
	aid, err := newID("attachments.id", a.ID)
	if err != nil {
		return at, err
	}
	f, err := get[core.File](c, "file", "file", a.File)
	if err != nil {
		return at, err
	}
	if f.State != "ready" {
		return at, conflictErr("file %s is still uploading", f.Name)
	}
	if !contains([]string{"", "before", "after"}, a.Role) {
		return at, oneOf("role", "role", a.Role, []string{"before", "after"})
	}
	rk, err := nextRank[core.Attachment](c, store.Eq("subject_id", subjectID))
	if err != nil {
		return at, err
	}
	at = core.Attachment{ID: aid, WorkspaceID: c.ws, FileID: f.ID, SubjectType: subjectType, SubjectID: subjectID, TaskID: t.ID,
		Role: a.Role, Caption: a.Caption, Rank: rk, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if err := c.tx.Insert(c.ctx, at); err != nil {
		return at, taken(err, "id", aid)
	}
	// The event carries the file with where to fetch it, so a client can
	// show it without asking.
	f.URL = "/f/" + f.ID + "/" + url.PathEscape(f.Name)
	if f.PreviewKey != "" {
		f.PreviewURL = "/f/" + f.ID + "/preview"
	}
	at.File = &f
	return at, nil
}

func attachmentAdd(c *cx) error {
	var a attachArgs
	if err := c.args(&a); err != nil {
		return err
	}
	var t core.Task
	var subjectType, subjectID, docID string
	var err error
	switch {
	case a.Option != "":
		o, err := get[core.Option](c, "option", "option", a.Option)
		if err != nil {
			return err
		}
		d, err := get[core.Decision](c, "decision", "option", o.DecisionID)
		if err != nil {
			return err
		}
		subjectType, subjectID, a.Task = "decision_option", o.ID, d.TaskID
	case a.Decision != "":
		d, err := get[core.Decision](c, "decision", "decision", a.Decision)
		if err != nil {
			return err
		}
		subjectType, subjectID, a.Task = "decision", d.ID, d.TaskID
	case a.Comment != "":
		cm, err := get[core.Comment](c, "comment", "comment", a.Comment)
		if err != nil {
			return err
		}
		subjectType, subjectID, a.Task, docID = "comment", cm.ID, cm.TaskID, cm.DocID
	case a.Doc != "":
		d, err := get[core.Doc](c, "doc", "doc", a.Doc)
		if err != nil {
			return err
		}
		subjectType, subjectID, docID = "doc", d.ID, d.ID
	case a.Task != "":
	default:
		return invalid("task", "say what the file is shown on: task, comment, decision, option or doc")
	}
	if a.Task != "" {
		if t, err = c.task("task", a.Task); err != nil {
			return err
		}
		if subjectType == "" {
			subjectType, subjectID = "task", t.ID
		}
	}
	at, err := c.attach(a, subjectType, subjectID, t)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	c.ref = at.ID
	if t.ID != "" {
		if err := c.touch(t.ID, seq); err != nil {
			return err
		}
		return c.emit(seq, "attachment.created", "attachment", at.ID, "task", t.ID, t.ProjectID, map[string]any{"row": at, "key": t.Key})
	}
	return c.emit(seq, "attachment.created", "attachment", at.ID, "doc", docID, "", map[string]any{"row": at})
}

func attachmentRemove(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	at, err := get[core.Attachment](c, "attachment", "id", a.ID)
	if err != nil {
		return err
	}
	if at.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who attached a file, or an admin, can remove it")
	}
	// A file nothing shows any more goes to the trash with its last use.
	if n, err := c.tx.Count(c.ctx, "attachments", store.Eq("file_id", at.FileID), store.Live); err != nil {
		return err
	} else if n <= 1 {
		if _, err := c.tx.Update(c.ctx, "files", map[string]any{"deleted_at": c.at}, store.Eq("id", at.FileID)); err != nil {
			return err
		}
	}
	if at.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", at.TaskID)); err != nil {
			return err
		}
		return c.trash("attachments", "attachment", at.ID, "task", t.ID, t.ProjectID, nil)
	}
	return c.trash("attachments", "attachment", at.ID, "doc", at.SubjectID, "", nil)
}

// attachmentRestore puts a removed file back where it was, within the 30
// days its trash is kept.
func attachmentRestore(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	var at core.Attachment
	if a.ID == "" {
		return invalid("id", "id is required")
	}
	if err := c.tx.Get(c.ctx, &at, store.Eq("id", a.ID)); err != nil {
		return missing(err, "attachment", a.ID)
	}
	c.ref = at.ID
	if at.DeletedAt == 0 {
		return nil
	}
	if at.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who attached a file, or an admin, can put it back")
	}
	var f core.File
	if err := c.tx.Get(c.ctx, &f, store.Eq("id", at.FileID)); err != nil {
		return conflictErr("the file itself is gone for good; it was removed more than 30 days ago")
	}
	if f.DeletedAt != 0 {
		if _, err := c.tx.Update(c.ctx, "files", map[string]any{"deleted_at": int64(0)}, store.Eq("id", f.ID)); err != nil {
			return err
		}
		f.DeletedAt = 0
	}
	seq := c.tx.NextSeq()
	set := map[string]any{"deleted_at": int64(0)}
	if tb, ok := store.TableNamed("attachments"); ok {
		if _, has := tb.Type.FieldByName("UpdatedSeq"); has {
			set["updated_seq"] = seq
		}
	}
	if _, err := c.tx.Update(c.ctx, "attachments", set, store.Eq("id", at.ID)); err != nil {
		return err
	}
	at.DeletedAt, at.File = 0, &f
	scopeType, scopeID, projectID := "doc", at.SubjectID, ""
	if at.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", at.TaskID)); err != nil {
			return err
		}
		scopeType, scopeID, projectID = "task", t.ID, t.ProjectID
		if err := c.touch(t.ID, seq); err != nil {
			return err
		}
	}
	return c.emit(seq, "attachment.restored", "attachment", at.ID, scopeType, scopeID, projectID, map[string]any{"row": at})
}

// ---- comments ----

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

func commentCreate(c *cx) error {
	var a commentCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Body) == "" {
		return invalid("body", "a comment needs text")
	}
	kind := a.Kind
	if kind == "" {
		kind = "comment"
		if a.Evidence != nil {
			kind = "result"
		}
	}
	if kind != "comment" && kind != "result" {
		return oneOf("kind", "kind", a.Kind, []string{"comment", "result"})
	}
	cm := core.Comment{ID: cid, WorkspaceID: c.ws, Kind: kind, Evidence: a.Evidence, AuthorID: c.actor.UserID, Body: a.Body, CreatedAt: c.at}
	if a.Parent != "" {
		parent, err := get[core.Comment](c, "comment", "parent", a.Parent)
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
	}
	if a.Doc != "" || (a.Block != "" && a.Task == "") {
		return c.docComment(cm, a)
	}
	// A comment on an option or a decision knows its task.
	if a.Option != "" {
		o, err := get[core.Option](c, "option", "option", a.Option)
		if err != nil {
			return err
		}
		cm.SubjectType, cm.SubjectID, a.Decision = "decision_option", o.ID, o.DecisionID
	}
	if a.Decision != "" {
		d, err := get[core.Decision](c, "decision", "decision", a.Decision)
		if err != nil {
			return err
		}
		if a.Task == "" {
			a.Task = d.TaskID
		}
		if cm.SubjectType == "" {
			cm.SubjectType, cm.SubjectID = "decision", d.ID
		}
		if t, err := c.task("task", a.Task); err != nil {
			return err
		} else if t.ID != d.TaskID {
			return invalid("decision", "that decision belongs to another task")
		}
	}
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	if cm.SubjectType == "" {
		cm.SubjectType, cm.SubjectID = "task", t.ID
	}
	cm.TaskID = t.ID
	seq := c.tx.NextSeq()
	cm.CreatedSeq, cm.UpdatedSeq = seq, seq
	if err := c.tx.Insert(c.ctx, cm); err != nil {
		return taken(err, "id", cid)
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
	if err := c.touch(t.ID, seq); err != nil {
		return err
	}
	data := map[string]any{"row": cm, "key": t.Key}
	if len(atts) > 0 {
		data["attachments"] = atts
	}
	c.ref, c.key = cm.ID, t.Key
	if err := c.emit(seq, "comment.created", "comment", cm.ID, "task", t.ID, t.ProjectID, data); err != nil {
		return err
	}
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
		if err := c.notifyTask(m.UserID, core.NoteMentioned, t, "comment", cm.ID, cm.Body); err != nil {
			return err
		}
	}
	if cm.ParentID != "" {
		var parent core.Comment
		if err := c.tx.Get(c.ctx, &parent, store.Eq("id", cm.ParentID)); err == nil {
			if err := c.notifyTask(parent.AuthorID, core.NoteReplied, t, "comment", cm.ID, cm.Body); err != nil {
				return err
			}
		}
	}
	note := core.NoteComment
	if kind == "result" {
		note = core.NoteResult
	}
	// Hand the task on: where the caller said, or for a result, back to
	// whoever answered last.
	handTo, handNote := "", a.WaitingOnNote
	switch {
	case a.WaitingOn.Set && !a.WaitingOn.Null && a.WaitingOn.V != "":
		if handTo, err = c.optMember("waiting_on", a.WaitingOn.V); err != nil {
			return err
		}
	case a.WaitingOn.Set:
		if err := c.setWaitingOn(t, "", ""); err != nil {
			return err
		}
	case kind == "result":
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
		if err := c.notifyTask(handTo, note, t, "comment", cm.ID, cm.Body); err != nil {
			return err
		}
		if err := c.setWaitingOn(t, handTo, handNote); err != nil {
			return err
		}
	}
	if err := c.notifyWatchers(t, note, "comment", cm.ID, cm.Body); err != nil {
		return err
	}
	return c.index("comment", cm.ID, "task", t.ID, t.ProjectID, "", t.Key+" "+t.Title, cm.Body)
}

// docComment adds a comment to a doc or one of its blocks.
func (c *cx) docComment(cm core.Comment, a commentCreateArgs) error {
	if a.Block != "" {
		b, err := get[core.Block](c, "block", "block", a.Block)
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
		return taken(err, "id", cm.ID)
	}
	c.ref = cm.ID
	if err := c.emitTo(d.OwnerID, seq, "comment.created", "comment", cm.ID, "doc", d.ID, d.ProjectID, map[string]any{"row": cm}); err != nil {
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
		if err := c.tx.Get(c.ctx, &parent, store.Eq("id", cm.ParentID)); err == nil {
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
	return c.index("comment", cm.ID, "doc", d.ID, d.ProjectID, d.OwnerID, d.Title, cm.Body)
}

// commentScope returns where a comment's events belong.
func (c *cx) commentScope(cm core.Comment) (scopeType, scopeID, projectID, key string, err error) {
	if cm.TaskID != "" {
		var t core.Task
		if err = c.tx.Get(c.ctx, &t, store.Eq("id", cm.TaskID)); err != nil {
			return
		}
		return "task", t.ID, t.ProjectID, t.Key, nil
	}
	return "doc", cm.DocID, "", "", nil
}

type commentUpdateArgs struct {
	ID       string      `json:"id"`
	Body     Opt[string] `json:"body"`
	Resolved Opt[bool]   `json:"resolved"`
}

func commentUpdate(c *cx) error {
	var a commentUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cm, err := get[core.Comment](c, "comment", "id", a.ID)
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
		p.str("body", a.Body, &cm.Body)
		if !p.empty() {
			p.set["edited_at"] = c.at
		}
	}
	if a.Resolved.Set {
		if a.Resolved.V && cm.ResolvedAt == 0 {
			p.put("resolved_at", int64(0), c.at)
		} else if !a.Resolved.V && cm.ResolvedAt != 0 {
			p.put("resolved_at", cm.ResolvedAt, int64(0))
		}
	}
	st, sid, pid, key, err := c.commentScope(cm)
	if err != nil {
		return err
	}
	if err := c.save(p, "comments", "comment", cm.ID, st, sid, pid, map[string]any{"key": key}); err != nil {
		return err
	}
	if _, ok := p.set["body"]; ok {
		if _, err := c.link("comment", cm.ID, st, sid, cm.Body); err != nil {
			return err
		}
	}
	return nil
}

func commentDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cm, err := get[core.Comment](c, "comment", "id", a.ID)
	if err != nil {
		return err
	}
	if cm.AuthorID != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only its author, or an admin, can delete a comment")
	}
	st, sid, pid, key, err := c.commentScope(cm)
	if err != nil {
		return err
	}
	if err := c.tx.Unindex(c.ctx, cm.ID); err != nil {
		return err
	}
	return c.trash("comments", "comment", cm.ID, st, sid, pid, map[string]any{"key": key})
}

// ---- decisions ----

type optionArgs struct {
	ID          string       `json:"id"`
	Label       string       `json:"label"`
	Description string       `json:"description"`
	Attachments []attachArgs `json:"attachments"`
}

type decisionOpenArgs struct {
	ID       string       `json:"id"`
	Task     string       `json:"task"`
	Kind     string       `json:"kind"` // choice (default when options are given) or approval
	Question string       `json:"question"`
	Details  string       `json:"details"`
	Options  []optionArgs `json:"options"`
	// Recommended is the option the asker would pick: its position in
	// options starting at 1, or its id.
	Recommended    any    `json:"recommended"`
	Recommendation string `json:"recommendation"`
	// Ask is who should answer. The task then waits on them. An agent that
	// names nobody asks the person responsible for it.
	Ask string `json:"ask"`
	// Action, on an approval, is the change type the asker wants to make,
	// and Args the arguments it will be sent with. The approval then covers
	// exactly that change, once.
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args"`
}

func (c *cx) loadOptions(d *core.Decision) error {
	return c.tx.List(c.ctx, &d.Options, store.Q{Where: []store.Cond{store.Eq("decision_id", d.ID), store.Live}, Order: "rank"})
}

func decisionOpen(c *cx) error {
	var a decisionOpenArgs
	if err := c.args(&a); err != nil {
		return err
	}
	did, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Question) == "" {
		return invalid("question", "a decision needs a question")
	}
	kind := a.Kind
	if kind == "" {
		kind = core.DecisionChoice
		if len(a.Options) == 0 {
			kind = core.DecisionApproval
		}
	}
	switch kind {
	case core.DecisionChoice:
		if len(a.Options) < 2 {
			return invalid("options", "a choice needs at least two options; for a plain yes or no use kind \"approval\"")
		}
	case core.DecisionApproval:
		if len(a.Options) > 0 {
			return invalid("options", "an approval has no options: it is answered approved or declined")
		}
		if a.Action != "" {
			if _, ok := handlers[a.Action]; !ok {
				return oneOf("action", "change type", a.Action, ChangeTypes())
			}
			var args map[string]any
			if len(a.Args) == 0 || json.Unmarshal(a.Args, &args) != nil || len(args) == 0 {
				return invalid("args", "say what exactly is to be approved: args are the arguments %s will be sent with, e.g. {\"id\": \"SVA-12\"}. The approval covers that change and no other", a.Action)
			}
		} else if len(a.Args) > 0 {
			return invalid("args", "args go with an action")
		}
	default:
		return oneOf("kind", "kind", kind, []string{core.DecisionChoice, core.DecisionApproval})
	}
	asked := ""
	if a.Ask != "" {
		if asked, err = c.optMember("ask", a.Ask); err != nil {
			return err
		}
		if asked == c.actor.UserID {
			return invalid("ask", "you cannot ask yourself: someone else has to answer")
		}
	} else if c.actor.Kind == core.KindAgent {
		var self core.User
		if err := c.tx.Get(c.ctx, &self, store.Eq("id", c.actor.UserID)); err != nil {
			return err
		}
		asked = self.ResponsibleID
	}

	d := core.Decision{ID: did, WorkspaceID: c.ws, TaskID: t.ID, Kind: kind, Question: strings.TrimSpace(a.Question), Details: a.Details,
		Action: a.Action, ActionArgs: a.Args, State: core.StateOpen, AskedID: asked, Recommendation: a.Recommendation,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	seen := map[string]bool{}
	for i, o := range a.Options {
		oid, err := newID("options.id", o.ID)
		if err != nil {
			return err
		}
		if seen[oid] {
			return invalid("options", "two options share the id %s", oid)
		}
		seen[oid] = true
		if strings.TrimSpace(o.Label) == "" {
			return invalid("options", "option %d needs a label", i+1)
		}
		d.Options = append(d.Options, core.Option{ID: oid, WorkspaceID: c.ws, DecisionID: did, Label: strings.TrimSpace(o.Label),
			Description: o.Description, Rank: rank.ForNumber(i + 1), CreatedAt: c.at})
	}
	switch r := a.Recommended.(type) {
	case nil:
	case float64:
		if r < 1 || int(r) > len(d.Options) {
			return invalid("recommended", "recommended is the position of an option, 1 to %d, or its id", len(d.Options))
		}
		d.RecommendedOptionID = d.Options[int(r)-1].ID
	case string:
		if !seen[r] {
			return invalid("recommended", "the recommended option is not one of the options")
		}
		d.RecommendedOptionID = r
	default:
		return invalid("recommended", "recommended is the position of an option, or its id")
	}

	// Decisions keep the order they were asked in.
	n, err := c.tx.Count(c.ctx, "decisions", store.Eq("task_id", t.ID))
	if err != nil {
		return err
	}
	d.Rank = rank.ForNumber(n + 1)
	seq := c.tx.NextSeq()
	d.CreatedSeq, d.UpdatedSeq = seq, seq
	if err := c.tx.Insert(c.ctx, d); err != nil {
		return taken(err, "id", did)
	}
	var atts []core.Attachment
	for i, o := range d.Options {
		if err := c.tx.Insert(c.ctx, o); err != nil {
			return taken(err, "option id", o.ID)
		}
		for _, aa := range a.Options[i].Attachments {
			at, err := c.attach(aa, "decision_option", o.ID, t)
			if err != nil {
				return err
			}
			atts = append(atts, at)
		}
	}
	if err := c.touch(t.ID, seq); err != nil {
		return err
	}
	data := map[string]any{"row": d, "key": t.Key}
	if len(atts) > 0 {
		data["attachments"] = atts
	}
	c.ref, c.key = d.ID, t.Key
	if err := c.emit(seq, "decision.opened", "decision", d.ID, "task", t.ID, t.ProjectID, data); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "task", t.ID); err != nil {
		return err
	}
	body := d.Details
	for _, o := range d.Options {
		body += "\n" + o.Label + " " + o.Description
	}
	if err := c.index("decision", d.ID, "task", t.ID, t.ProjectID, "", d.Question, body); err != nil {
		return err
	}
	if asked == "" {
		return nil
	}
	if err := c.watch(asked, "task", t.ID); err != nil {
		return err
	}
	if err := c.notifyTask(asked, core.NoteAsked, t, "decision", d.ID, d.Question); err != nil {
		return err
	}
	// A closed task waits on nobody; the question still reaches its inbox.
	var st core.Status
	if err := c.tx.Get(c.ctx, &st, store.Eq("id", t.StatusID)); err == nil && !core.OpenCategory(st.Category) {
		return nil
	}
	return c.setWaitingOn(t, asked, "answer: "+snippet(d.Question, 80))
}

type decisionUpdateArgs struct {
	ID             string      `json:"id"`
	Question       Opt[string] `json:"question"`
	Details        Opt[string] `json:"details"`
	Recommendation Opt[string] `json:"recommendation"`
	Recommended    Opt[string] `json:"recommended"` // an option id
}

func (c *cx) decisionTask(ref string) (core.Decision, core.Task, error) {
	if ref != "" && !looksLikeID(ref) {
		// By its task: "SVA-7" is that task's one open decision, "SVA-7#2"
		// its second decision in the order they were asked.
		id, err := c.decisionOnTask(ref)
		if err != nil {
			return core.Decision{}, core.Task{}, err
		}
		ref = id
	}
	d, err := get[core.Decision](c, "decision", "id", ref)
	if err != nil {
		return d, core.Task{}, err
	}
	if err := c.loadOptions(&d); err != nil {
		return d, core.Task{}, err
	}
	t, err := c.task("id", d.TaskID)
	return d, t, err
}

func decisionUpdate(c *cx) error {
	var a decisionUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if d.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who asked can edit a decision")
	}
	if d.State != core.StateOpen {
		return conflictErr("this decision was already answered; open a new one to ask again")
	}
	p := newPatch()
	if err := p.name("question", a.Question, &d.Question); err != nil {
		return err
	}
	p.str("details", a.Details, &d.Details)
	p.str("recommendation", a.Recommendation, &d.Recommendation)
	if a.Recommended.Set {
		if !a.Recommended.Null && !hasOption(d, a.Recommended.V) {
			return &Error{Code: CodeInvalid, Field: "recommended", Message: "recommended must be one of this decision's options", Allowed: optionIDs(d)}
		}
		p.str("recommended_option_id", a.Recommended, &d.RecommendedOptionID)
	}
	if !p.empty() {
		p.set["updated_at"] = c.at
	}
	if err := c.save(p, "decisions", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key}); err != nil {
		return err
	}
	return c.touch(t.ID, c.tx.Seq())
}

type decisionPickArgs struct {
	ID string `json:"id"`
	// Option is the option picked: its id, its position starting at 1, or
	// its label.
	Option  any    `json:"option"`
	Outcome string `json:"outcome"`
	Note    string `json:"note"`
}

func decisionPick(c *cx) error {
	var a decisionPickArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	// The first answer stands. A second one is refused, not merged.
	if d.State != core.StateOpen {
		return conflictErr("this decision was already answered (%s); open a new one to ask again", d.State)
	}
	if d.CreatedBy == c.actor.UserID {
		return forbidden("you asked this question, so someone else has to answer it")
	}
	if c.actor.Kind == core.KindAgent && d.AskedID != "" && d.AskedID != c.actor.UserID {
		return forbidden("this question was asked of someone else")
	}
	optionID := ""
	switch o := a.Option.(type) {
	case nil:
	case float64:
		if o < 1 || int(o) > len(d.Options) {
			return invalid("option", "option is a position, 1 to %d, an option id or a label", len(d.Options))
		}
		optionID = d.Options[int(o)-1].ID
	case string:
		for _, opt := range d.Options {
			if opt.ID == o || strings.EqualFold(opt.Label, o) {
				optionID = opt.ID
			}
		}
		// A position written as text ("2") is a position still.
		if n, err := strconv.Atoi(strings.TrimSpace(o)); optionID == "" && err == nil && n >= 1 && n <= len(d.Options) {
			optionID = d.Options[n-1].ID
		}
		if optionID == "" && o != "" {
			labels := make([]string, len(d.Options))
			for i, opt := range d.Options {
				labels[i] = opt.Label
			}
			return &Error{Code: CodeInvalid, Field: "option", Message: "that is not one of this decision's options", Allowed: labels, Nearest: nearest(o, labels)}
		}
	default:
		return invalid("option", "option is a position, an option id or a label")
	}

	outcome := a.Outcome
	state := core.StatePicked
	if d.Kind == core.DecisionApproval {
		if optionID != "" {
			return invalid("option", "an approval has no options")
		}
		switch outcome {
		case core.OutcomeApproved:
		case core.OutcomeDeclined:
			state = core.StateSentBack
		default:
			return &Error{Code: CodeInvalid, Field: "outcome", Message: "an approval is answered approved or declined",
				Allowed: []string{core.OutcomeApproved, core.OutcomeDeclined}}
		}
	} else {
		if outcome == "" && optionID != "" {
			outcome = core.OutcomeAsIs
			if strings.TrimSpace(a.Note) != "" {
				outcome = core.OutcomeWithChanges
			}
		}
		switch outcome {
		case core.OutcomeAsIs, core.OutcomeWithChanges:
			if optionID == "" {
				return &Error{Code: CodeInvalid, Field: "option", Message: "say which option: its position, id or label", Allowed: optionIDs(d)}
			}
			if outcome == core.OutcomeWithChanges && strings.TrimSpace(a.Note) == "" {
				return invalid("note", "\"with_changes\" needs a note saying what to change")
			}
		case core.OutcomeNone:
			if optionID != "" {
				return invalid("option", "outcome \"none\" picks no option")
			}
			state = core.StateSentBack
		default:
			return &Error{Code: CodeInvalid, Field: "outcome", Message: "a choice is answered with an option, or sent back",
				Allowed: []string{core.OutcomeAsIs, core.OutcomeWithChanges, core.OutcomeNone}}
		}
	}

	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"state": state, "picked_option_id": optionID, "outcome": outcome,
		"outcome_note": a.Note, "decided_by": c.actor.UserID, "decided_at": c.at, "unclear_note": "", "updated_at": c.at, "updated_seq": seq},
		store.Eq("id", d.ID)); err != nil {
		return err
	}
	d.State, d.PickedOptionID, d.Outcome, d.OutcomeNote, d.DecidedBy, d.DecidedAt, d.UpdatedSeq, d.UnclearNote = state, optionID, outcome, a.Note, c.actor.UserID, c.at, seq, ""
	if err := c.touch(t.ID, seq); err != nil {
		return err
	}
	c.ref, c.key = d.ID, t.Key
	if err := c.emit(seq, "decision.picked", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"row": d, "key": t.Key}); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "task", t.ID); err != nil {
		return err
	}
	text := outcome
	for _, o := range d.Options {
		if o.ID == optionID {
			text = o.Label
		}
	}
	if a.Note != "" {
		text += ": " + a.Note
	}
	// The answer is in, so the next move is the asker's.
	if err := c.notifyTask(d.CreatedBy, core.NotePicked, t, "decision", d.ID, text); err != nil {
		return err
	}
	if _, err := c.memberRef("id", d.CreatedBy); err != nil {
		return nil // the asker left the workspace
	}
	// Other open questions on the task keep it with whoever must answer them.
	if n, err := c.tx.Count(c.ctx, "decisions", store.Eq("task_id", t.ID), store.Eq("state", core.StateOpen), store.Live,
		store.Eq("asked_id", c.actor.UserID)); err != nil || n > 0 {
		return err
	}
	return c.setWaitingOn(t, d.CreatedBy, "answered: "+snippet(text, 80))
}

type decisionUnclearArgs struct {
	ID   string `json:"id"`
	Note string `json:"note"` // what is unclear, in one line
}

// decisionUnclear is the asker saying the answer does not settle the
// question. The decision opens again and goes back to whoever answered.
func decisionUnclear(c *cx) error {
	var a decisionUnclearArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if d.CreatedBy != c.actor.UserID {
		return forbidden("only the one who asked can say the answer is unclear")
	}
	if d.State == core.StateOpen {
		return conflictErr("this decision has no answer yet")
	}
	if strings.TrimSpace(a.Note) == "" {
		return invalid("note", "say in one line what is unclear")
	}
	answerer := d.DecidedBy
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"state": core.StateOpen, "unclear_note": a.Note, "asked_id": answerer,
		"picked_option_id": "", "outcome": "", "outcome_note": "", "decided_by": "", "decided_at": 0, "updated_at": c.at, "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	prev := map[string]any{"picked_option_id": d.PickedOptionID, "outcome": d.Outcome, "outcome_note": d.OutcomeNote, "decided_by": d.DecidedBy}
	d.State, d.UnclearNote, d.AskedID, d.PickedOptionID, d.Outcome, d.OutcomeNote, d.DecidedBy, d.DecidedAt, d.UpdatedSeq = core.StateOpen, a.Note, answerer, "", "", "", "", 0, seq
	if err := c.touch(t.ID, seq); err != nil {
		return err
	}
	c.ref, c.key = d.ID, t.Key
	if err := c.emit(seq, "decision.unclear", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"row": d, "key": t.Key, "previous": prev}); err != nil {
		return err
	}
	if err := c.notifyTask(answerer, core.NoteUnclear, t, "decision", d.ID, a.Note); err != nil {
		return err
	}
	return c.setWaitingOn(t, answerer, "unclear: "+snippet(a.Note, 80))
}

func decisionDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if d.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who asked, or an admin, can delete a decision")
	}
	if err := c.tx.Unindex(c.ctx, d.ID); err != nil {
		return err
	}
	if err := c.trash("decisions", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key}); err != nil {
		return err
	}
	return c.touch(t.ID, c.tx.Seq())
}

// decisionRestore takes a decision back out of the trash, as it was.
func decisionRestore(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	var d core.Decision
	if a.ID == "" {
		return invalid("id", "id is required")
	}
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", a.ID)); err != nil {
		return missing(err, "decision", a.ID)
	}
	t, err := c.anyTask("id", d.TaskID)
	if err != nil {
		return err
	}
	c.ref, c.key = d.ID, t.Key
	if d.DeletedAt == 0 {
		return nil // not in the trash: nothing to do
	}
	if t.DeletedAt != 0 {
		return conflictErr("%s is in the trash; restore the task first", t.Key)
	}
	if d.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who asked, or an admin, can restore a decision")
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"deleted_at": int64(0), "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	d.DeletedAt, d.UpdatedSeq = 0, seq
	if err := c.loadOptions(&d); err != nil {
		return err
	}
	body := d.Details
	for _, o := range d.Options {
		body += "\n" + o.Label + " " + o.Description
	}
	if err := c.index("decision", d.ID, "task", t.ID, t.ProjectID, "", d.Question, body); err != nil {
		return err
	}
	if err := c.touch(t.ID, seq); err != nil {
		return err
	}
	// The whole decision goes out again: a copy that dropped it has it back.
	return c.emit(seq, "decision.restored", "decision", d.ID, "task", t.ID, t.ProjectID, map[string]any{"row": d, "key": t.Key})
}

func hasOption(d core.Decision, optionID string) bool {
	for _, o := range d.Options {
		if o.ID == optionID {
			return optionID != ""
		}
	}
	return false
}

func optionIDs(d core.Decision) []string {
	out := make([]string, len(d.Options))
	for i, o := range d.Options {
		out[i] = o.ID
	}
	return out
}

// ---- standing preferences ----

type preferenceCreateArgs struct {
	ID       string   `json:"id"`
	Body     string   `json:"body"`
	Project  string   `json:"project"`  // empty = the whole workspace
	Decision string   `json:"decision"` // the decision it came from
	Labels   []string `json:"labels"`   // shown on tasks with any of these labels; empty = all tasks
}

func preferenceCreate(c *cx) error {
	var a preferenceCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Body) == "" {
		return invalid("body", "a preference needs its rule in words")
	}
	pf := core.Preference{ID: pid, WorkspaceID: c.ws, Body: strings.TrimSpace(a.Body), CreatedBy: c.actor.UserID, CreatedAt: c.at}
	var pr core.Project
	if a.Decision != "" {
		d, t, err := c.decisionTask(a.Decision)
		if err != nil {
			return err
		}
		pf.DecisionID = d.ID
		if a.Project == "" {
			a.Project = t.ProjectID
		}
	}
	scopeType, scopeID := "workspace", c.ws
	if a.Project != "" {
		if pr, err = c.project(a.Project); err != nil {
			return err
		}
		pf.ProjectID, scopeType, scopeID = pr.ID, "project", pr.ID
		if pf.LabelIDs, err = c.labelIDs(pr, "labels", a.Labels); err != nil {
			return err
		}
	} else if len(a.Labels) > 0 {
		return invalid("labels", "labels need a project")
	}
	seq := c.tx.NextSeq()
	pf.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, pf); err != nil {
		return taken(err, "id", pid)
	}
	return c.created(seq, "preference", pf.ID, scopeType, scopeID, pf.ProjectID, pf)
}

type preferenceUpdateArgs struct {
	ID      string      `json:"id"`
	Body    Opt[string] `json:"body"`
	Retired Opt[bool]   `json:"retired"`
}

func prefScope(c *cx, pf core.Preference) (string, string) {
	if pf.ProjectID != "" {
		return "project", pf.ProjectID
	}
	return "workspace", c.ws
}

func preferenceUpdate(c *cx) error {
	var a preferenceUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pf, err := get[core.Preference](c, "preference", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("body", a.Body, &pf.Body); err != nil {
		return err
	}
	if a.Retired.Set {
		if a.Retired.V && pf.RetiredAt == 0 {
			p.put("retired_at", int64(0), c.at)
		} else if !a.Retired.V && pf.RetiredAt != 0 {
			p.put("retired_at", pf.RetiredAt, int64(0))
		}
	}
	st, sid := prefScope(c, pf)
	return c.save(p, "preferences", "preference", pf.ID, st, sid, pf.ProjectID, nil)
}

func preferenceDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pf, err := get[core.Preference](c, "preference", "id", a.ID)
	if err != nil {
		return err
	}
	st, sid := prefScope(c, pf)
	return c.trash("preferences", "preference", pf.ID, st, sid, pf.ProjectID, nil)
}

// decisionOnTask resolves "KEY" or "KEY#N" to a decision's id.
func (c *cx) decisionOnTask(ref string) (string, error) {
	key, nth, numbered := strings.Cut(ref, "#")
	t, err := c.task("id", key)
	if err != nil {
		return "", err
	}
	var ds []core.Decision
	if err := c.tx.List(c.ctx, &ds, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_at"}); err != nil {
		return "", err
	}
	if numbered {
		n, err := strconv.Atoi(nth)
		if err != nil || n < 1 || n > len(ds) {
			return "", invalid("id", "%s has %d decisions; %q is not one of them", t.Key, len(ds), ref)
		}
		return ds[n-1].ID, nil
	}
	var open []core.Decision
	for _, d := range ds {
		if d.State == core.StateOpen {
			open = append(open, d)
		}
	}
	switch {
	case len(open) == 1:
		return open[0].ID, nil
	case len(ds) == 1:
		return ds[0].ID, nil
	case len(ds) == 0:
		return "", invalid("id", "%s has no decisions", t.Key)
	}
	return "", invalid("id", "%s has %d decisions, %d of them open; say which with %s#1, %s#2, …", t.Key, len(ds), len(open), t.Key, t.Key)
}
