package engine

import (
	"context"
	"errors"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("resource.create", core.RoleAdmin, resourceCreate)
	register("resource.delete", core.RoleAdmin, resourceDelete)
	register("resource.acquire", core.RoleMember, resourceAcquire)
	register("resource.release", core.RoleMember, resourceRelease)
}

type resourceCreateArgs struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func resourceCreate(c *cx, a resourceCreateArgs) error {
	rid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a resource needs a name")
	}
	seq := c.tx.NextSeq()
	r := core.Resource{ID: rid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Description: a.Description, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, r); err != nil {
		return taken(err, "resource name", r.Name)
	}
	return c.created(seq, "resource", r.ID, "workspace", c.ws, "", r)
}

func (c *cx) resource(ref string) (core.Resource, error) {
	var r core.Resource
	cond := store.Eq("name", ref)
	if isID(ref) {
		cond = store.Eq("id", ref)
	}
	err := c.tx.Get(c.ctx, &r, cond, store.Live)
	if errors.Is(err, store.ErrNotFound) {
		var all []core.Resource
		if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
			return r, err
		}
		names := make([]string, len(all))
		for i, x := range all {
			names[i] = x.Name
		}
		e := notFound("resource", ref)
		e.Field, e.Allowed, e.Nearest = "resource", names, nearest(ref, names)
		return r, e
	}
	return r, err
}

func resourceDelete(c *cx, a idArgs) error {
	r, err := c.resource(a.ID)
	if err != nil {
		return err
	}
	return c.trash("resources", "resource", r.ID, "workspace", c.ws, "", nil)
}

type resourceAcquireArgs struct {
	ID       string `json:"id"`
	Resource string `json:"resource"` // name or id
	Task     string `json:"task"`
	Note     string `json:"note"`
	Minutes  int    `json:"minutes"` // how long the hold lasts without renewing; default 30
}

// activeClaims returns a resource's live claims in queue order, after
// releasing a hold whose lease ran out.
func (c *cx) activeClaims(r core.Resource) ([]core.ResourceClaim, error) {
	var claims []core.ResourceClaim
	if err := c.tx.List(c.ctx, &claims, store.Q{Where: []store.Cond{store.Eq("resource_id", r.ID), store.Ne("state", "released")}, Order: "requested_at,id"}); err != nil {
		return nil, err
	}
	var live []core.ResourceClaim
	for _, cl := range claims {
		if cl.State == "holding" && cl.LeaseUntil != 0 && cl.LeaseUntil < c.at {
			if err := c.setClaim(cl, map[string]any{"state": "released", "released_at": c.at}, "expired"); err != nil {
				return nil, err
			}
			continue
		}
		live = append(live, cl)
	}
	return live, nil
}

func (c *cx) setClaim(cl core.ResourceClaim, set map[string]any, why string) error {
	if _, err := c.tx.Update(c.ctx, "resource_claims", set, store.Eq("id", cl.ID)); err != nil {
		return err
	}
	changes := map[string]core.FieldChange{}
	for k, v := range set {
		changes[k] = core.FieldChange{To: v}
	}
	// Letting go of a hold, or having it run out, is never refused: also
	// not to someone limited to other projects since they took it.
	was := c.system
	c.system = true
	err := c.emit(c.tx.NextSeq(), "claim.updated", "claim", cl.ID, "workspace", c.ws, c.claimProject(cl), map[string]any{"id": cl.ID, "changes": changes, "why": why, "resource_id": cl.ResourceID, "user_id": cl.UserID, "task_id": cl.TaskID})
	c.system = was
	return err
}

// claimProject is the project of the task a claim was made for, so that a
// member limited to other projects is not told of it.
func (c *cx) claimProject(cl core.ResourceClaim) string {
	if cl.TaskID == "" {
		return ""
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", cl.TaskID)); err != nil {
		return ""
	}
	return t.ProjectID
}

// promote gives a free resource to the first in its queue.
func (c *cx) promote(r core.Resource, live []core.ResourceClaim) error {
	for _, cl := range live {
		if cl.State == "holding" {
			return nil
		}
	}
	if len(live) == 0 {
		return nil
	}
	next := live[0]
	// The one who was waiting gets half an hour to notice and renew.
	if err := c.setClaim(next, map[string]any{"state": "holding", "acquired_at": c.at, "lease_until": c.at + 30*60_000}, "acquired"); err != nil {
		return err
	}
	return c.notify(next.UserID, core.NoteWaitingOn, core.Notification{EntityType: "resource", EntityID: r.ID, TaskID: next.TaskID,
		Title: r.Name + " is yours now", Snippet: next.Note})
}

// resourceAcquire asks for a shared resource. The answer says whether the
// caller holds it now or is waiting in the queue; when it frees up the next
// in the queue is told.
func resourceAcquire(c *cx, a resourceAcquireArgs) error {
	r, err := c.resource(a.Resource)
	if err != nil {
		return err
	}
	if a.Minutes <= 0 {
		a.Minutes = 30
	}
	if a.Minutes > 24*60 {
		return invalid("minutes", "a hold lasts at most 1440 minutes; renew it by acquiring again")
	}
	live, err := c.activeClaims(r)
	if err != nil {
		return err
	}
	for _, cl := range live {
		if cl.UserID == c.actor.UserID {
			c.ref, c.key = cl.ID, cl.State
			if cl.State == "holding" { // renew
				return c.setClaim(cl, map[string]any{"lease_until": c.at + int64(a.Minutes)*60_000}, "renewed")
			}
			return nil // already queued
		}
	}
	cid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	cl := core.ResourceClaim{ID: cid, WorkspaceID: c.ws, ResourceID: r.ID, UserID: c.actor.UserID, Note: a.Note, State: "waiting", RequestedAt: c.at}
	if a.Task != "" {
		t, err := c.task("task", a.Task)
		if err != nil {
			return err
		}
		cl.TaskID = t.ID
	}
	held := false
	for _, o := range live {
		held = held || o.State == "holding"
	}
	if !held && len(live) == 0 {
		cl.State, cl.AcquiredAt, cl.LeaseUntil = "holding", c.at, c.at+int64(a.Minutes)*60_000
	}
	if err := c.tx.Insert(c.ctx, cl); err != nil {
		return taken(err, "id", cid)
	}
	c.ref, c.key = cl.ID, cl.State
	if err := c.emit(c.tx.NextSeq(), "claim.created", "claim", cl.ID, "workspace", c.ws, c.claimProject(cl), map[string]any{"row": cl, "resource": r.Name}); err != nil {
		return err
	}
	if cl.State == "waiting" {
		return c.promote(r, append(live, cl))
	}
	return nil
}

type resourceReleaseArgs struct {
	Resource string `json:"resource"`
	User     string `json:"user"` // an admin can release someone else's hold
}

func resourceRelease(c *cx, a resourceReleaseArgs) error {
	r, err := c.resource(a.Resource)
	if err != nil {
		return err
	}
	userID := c.actor.UserID
	if a.User != "" {
		m, err := c.memberRef("user", a.User)
		if err != nil {
			return err
		}
		if m.UserID != userID && !c.actor.Role.AtLeast(core.RoleAdmin) {
			return forbidden("only an admin can release someone else's hold")
		}
		userID = m.UserID
	}
	live, err := c.activeClaims(r)
	if err != nil {
		return err
	}
	var rest []core.ResourceClaim
	for _, cl := range live {
		if cl.UserID == userID {
			if err := c.setClaim(cl, map[string]any{"state": "released", "released_at": c.at}, "released"); err != nil {
				return err
			}
			continue
		}
		rest = append(rest, cl)
	}
	return c.promote(r, rest)
}

// ExpireHolds frees shared resources whose holder let the hold run out, and
// gives each to the next in its queue. It is safe to run as often as wanted.
func (e *Engine) ExpireHolds(ctx context.Context) error {
	now := e.now().UnixMilli()
	var stale []core.ResourceClaim
	if err := e.st.List(ctx, &stale, store.Where(store.Eq("state", "holding"), store.Lt("lease_until", now))); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, cl := range stale {
		if seen[cl.ResourceID] || cl.LeaseUntil == 0 {
			continue
		}
		seen[cl.ResourceID] = true
		err := e.System(ctx, cl.WorkspaceID, cl.UserID, func(s *Sys) error {
			var r core.Resource
			if err := s.c.tx.Get(ctx, &r, store.Eq("id", cl.ResourceID), store.Live); err != nil {
				return nil
			}
			live, err := s.c.activeClaims(r)
			if err != nil {
				return err
			}
			return s.c.promote(r, live)
		})
		if err != nil {
			return err
		}
	}
	return nil
}
