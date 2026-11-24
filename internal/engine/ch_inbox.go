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
	conds := []store.Cond{store.Eq("user_id", c.actor.UserID)}
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
	return c.emit(event{seq: c.tx.NextSeq(), typ: "notification.updated", entity: "notification", entityID: ids[0], place: inWorkspace(c.ws), audience: c.actor.UserID, data: core.EventData{IDs: ids, Changes: changes}})
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
