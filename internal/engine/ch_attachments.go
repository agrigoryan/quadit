// attachment.*: files on tasks, comments, decisions and pages.

package engine

import (
	"net/url"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers attachment.*.
func init() {
	register("attachment.add", core.RoleMember, attachmentAdd)
	register("attachment.remove", core.RoleMember, attachmentRemove)
	register("attachment.restore", core.RoleMember, attachmentRestore)
}

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
	f, err := loadLive[core.File](c, "file", "file", a.File)
	if err != nil {
		return at, err
	}
	if f.State != "ready" {
		return at, conflictErr("file %s is still uploading", f.Name)
	}
	if !slices.Contains([]string{"", "before", "after"}, a.Role) {
		return at, oneOf("role", "role", a.Role, []string{"before", "after"})
	}
	rk, err := nextRank[core.Attachment](c, store.Eq("subject_id", subjectID))
	if err != nil {
		return at, err
	}
	at = core.Attachment{ID: aid, WorkspaceID: c.ws, FileID: f.ID, SubjectType: subjectType, SubjectID: subjectID, TaskID: t.ID,
		Role: a.Role, Caption: a.Caption, Rank: rk, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if err := c.tx.Insert(c.ctx, at); err != nil {
		return at, alreadyInUse(err, "id", aid)
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

// attachmentAdd attaches an uploaded file to an option, a decision, a
// comment, a page or a task.
func attachmentAdd(c *cx, a attachArgs) error {
	var t core.Task
	var subjectType, subjectID, docID string
	var err error
	switch {
	case a.Option != "":
		o, err := loadLive[core.Option](c, "option", "option", a.Option)
		if err != nil {
			return err
		}
		decision, err := loadLive[core.Decision](c, "decision", "option", o.DecisionID)
		if err != nil {
			return err
		}
		subjectType, subjectID, a.Task = "decision_option", o.ID, decision.TaskID
	case a.Decision != "":
		decision, err := loadLive[core.Decision](c, "decision", "decision", a.Decision)
		if err != nil {
			return err
		}
		subjectType, subjectID, a.Task = "decision", decision.ID, decision.TaskID
	case a.Comment != "":
		cm, err := loadLive[core.Comment](c, "comment", "comment", a.Comment)
		if err != nil {
			return err
		}
		subjectType, subjectID, a.Task, docID = "comment", cm.ID, cm.TaskID, cm.DocID
	case a.Doc != "":
		doc, err := loadLive[core.Doc](c, "doc", "doc", a.Doc)
		if err != nil {
			return err
		}
		subjectType, subjectID, docID = "doc", doc.ID, doc.ID
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
		if err := c.touchTask(t.ID, seq); err != nil {
			return err
		}
		return c.emit(event{seq: seq, typ: "attachment.created", entity: "attachment", entityID: at.ID, place: inTask(t), data: map[string]any{"row": at, "key": t.Key}})
	}
	return c.emit(event{seq: seq, typ: "attachment.created", entity: "attachment", entityID: at.ID, place: place{scopeType: "doc", scopeID: docID}, data: map[string]any{"row": at}})
}

// attachmentRemove puts an attachment in the trash; its file stays until the
// trash is purged.
func attachmentRemove(c *cx, a idArgs) error {
	at, err := loadLive[core.Attachment](c, "attachment", "id", a.ID)
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
		return c.trash(target{table: "attachments", entity: "attachment", id: at.ID, place: inTask(t)})
	}
	return c.trash(target{table: "attachments", entity: "attachment", id: at.ID, place: place{scopeType: "doc", scopeID: at.SubjectID}})
}

// attachmentRestore puts a removed file back where it was, within the 30
// days its trash is kept.
func attachmentRestore(c *cx, a idArgs) error {
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
	ok, err := found(c.tx.Get(c.ctx, &f, store.Eq("id", at.FileID)))
	if err != nil {
		return err
	}
	if !ok {
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
	where := place{scopeType: "doc", scopeID: at.SubjectID}
	if at.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", at.TaskID)); err != nil {
			return err
		}
		where = inTask(t)
		if err := c.touchTask(t.ID, seq); err != nil {
			return err
		}
	}
	return c.emit(event{seq: seq, typ: "attachment.restored", entity: "attachment", entityID: at.ID, place: where, data: map[string]any{"row": at}})
}
