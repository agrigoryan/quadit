// notification.read and notify: the inbox.

package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("notification.read", core.RoleMember, notificationRead)
	register("notify", core.RoleMember, notifyMember)
}

type notificationReadArgs struct {
	IDs []string `json:"ids"`
	// Task marks everything about one task. All marks the whole inbox.
	Task string `json:"task"`
	All  bool   `json:"all"`
	// Addressed, with all, keeps to the items meant for the caller (true)
	// or to those heard only as a follower (false): one group of the inbox.
	Addressed Opt[bool] `json:"addressed"`
	// UpTo limits "all" to items at or before this feed position, so items
	// that arrived while the caller was reading stay unread.
	UpTo int64 `json:"up_to"`
	// Unread puts the items back as unread. Archive takes them out of the
	// inbox, and Unarchive puts archived ones back in, read or not as they were.
	Unread    bool `json:"unread"`
	Archive   bool `json:"archive"`
	Unarchive bool `json:"unarchive"`
}

// notificationRead marks the caller's inbox items as handled.
func notificationRead(c *cx, a notificationReadArgs) error {
	if a.Archive && a.Unarchive {
		return invalid("unarchive", "say archive or unarchive, not both")
	}
	var conds []store.Cond
	switch {
	case len(a.IDs) > 0:
		conds = append(conds, store.In("id", a.IDs))
	case a.Task != "":
		t, err := c.task("task", a.Task)
		if err != nil {
			return err
		}
		conds = append(conds, store.Eq("task_id", t.ID))
	case a.All:
	default:
		return invalid("ids", "say which items: ids, task, or all")
	}
	if a.Addressed.Set {
		if !a.All || a.Addressed.Null {
			return invalid("addressed", "addressed (true or false) keeps all to one group: give it with all")
		}
		conds = append(conds, store.Eq("addressed", a.Addressed.V))
	}
	if a.UpTo > 0 {
		conds = append(conds, store.Lte("seq", a.UpTo))
	}
	var set map[string]any
	switch {
	case a.Archive:
		conds = append(conds, store.Null("archived_at"))
		set = map[string]any{"archived_at": c.at, "read_at": c.at}
	case a.Unarchive:
		conds = append(conds, store.NotNull("archived_at"))
		set = map[string]any{"archived_at": int64(0)}
	case a.Unread:
		conds = append(conds, store.NotNull("read_at"))
		set = map[string]any{"read_at": int64(0)}
	default:
		conds = append(conds, store.Null("read_at"))
		set = map[string]any{"read_at": c.at}
	}
	return c.markInbox(c.actor.UserID, conds, set)
}

// markInbox sets set on the inbox items of the member userID that conds
// select, and tells that member alone (notification.updated, with the ids
// and the changes), as notification.read does for the caller's own: the
// one place an inbox item is marked.
func (c *cx) markInbox(userID string, conds []store.Cond, set map[string]any) error {
	conds = append([]store.Cond{store.Eq("user_id", userID)}, conds...)
	// Every notification the conditions select, read and then changed by
	// the same conditions: no other write to the workspace runs between.
	var rows []core.Notification
	if err := c.tx.List(c.ctx, &rows, store.Where(conds...)); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	if _, err := c.tx.Update(c.ctx, "notifications", set, conds...); err != nil {
		return err
	}
	changes := map[string]core.FieldChange{}
	for k, v := range set {
		changes[k] = core.FieldChange{To: v}
	}
	return c.emit(event{seq: c.tx.NextSeq(), typ: "notification.updated", entity: "notification", entityID: ids[0], place: inWorkspace(c.ws), audience: userID, data: core.EventData{IDs: ids, Changes: changes}})
}

// readWrittenOn marks read the actor's own unread inbox items of the task
// taskID at or before the feed position upTo, for a write of theirs on the
// task (a comment, a reply, a result, an answer): acting on a task is
// having read what was there. Only a change its actor applies in person
// does: what the engine writes in a member's name (a rule, a sync, a job,
// all through System) reads nothing of theirs.
func (c *cx) readWrittenOn(taskID string, upTo int64) error {
	// A quiet change brings history in (an import): nothing of its
	// writer's was read by it.
	if c.system || c.quiet {
		return nil
	}
	return c.markInbox(c.actor.UserID, []store.Cond{store.Eq("task_id", taskID), store.Lte("seq", upTo), store.Null("read_at")},
		map[string]any{"read_at": c.at})
}

// readQuestion marks read the unread inbox items that asked the member it
// is asked of to answer the decision d (decision_asked, unclear), once it
// is no longer open to them: answered, or in the trash. Each answer reads
// the items of the one asked then, so those of whoever was asked before
// were read by theirs; and the member's unread items are what the inbox's
// index finds. The asker's item of the answer (picked) is news, and stays
// as it is.
func (c *cx) readQuestion(d core.Decision) error {
	if d.AskedID == "" {
		return nil
	}
	return c.markInbox(d.AskedID, []store.Cond{store.Null("read_at"), store.Eq("entity_type", "decision"), store.Eq("entity_id", d.ID),
		store.In("type", []string{core.NoteAsked, core.NoteUnclear})}, map[string]any{"read_at": c.at})
}

type notifyArgs struct {
	User    string `json:"user" quadit:"required,handler"`
	Task    string `json:"task"`
	Message string `json:"message" quadit:"required,handler"`
}

// notifyMember puts a plain message in a member's inbox. Rules use it.
func notifyMember(c *cx, a notifyArgs) error {
	m, err := c.memberRef("user", a.User)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Message) == "" {
		return invalid("message", "say what the member should know")
	}
	n := core.Notification{EntityType: "member", EntityID: m.UserID, Title: a.Message, Addressed: true}
	if a.Task != "" {
		t, err := c.task("task", a.Task)
		if err != nil {
			return err
		}
		n.TaskID, n.EntityType, n.EntityID, n.Title, n.Snippet = t.ID, "task", t.ID, t.Key+" "+t.Title, a.Message
	}
	if c.system {
		// A rule may tell the very member whose change set it off.
		c.notified, c.selfNotify = map[string]bool{}, true
		defer func() { c.selfNotify = false }()
		return c.notify(m.UserID, core.NoteWaitingOn, n)
	}
	return c.notify(m.UserID, core.NoteMentioned, n)
}
