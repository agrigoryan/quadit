// member.add, member.update and member.remove.

package engine

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("member.add", core.RoleAdmin, memberAdd)
	register("member.update", core.RoleAdmin, memberUpdate)
	register("member.remove", core.RoleAdmin, memberRemove)
}

type memberAddArgs struct {
	User   string `json:"user" quadit:"required,handler"` // an existing person: their id or their email
	Handle string `json:"handle"`
	Role   string `json:"role"`
	Title  string `json:"title"`
	// Scope limits the person to some projects, or to reading.
	Scope *scopeArgs `json:"scope"`
}

// roleArg reads the role to give a member of the kind given (a person or
// an agent), up to the actor's own.
func (c *cx) roleArg(s, kind string) (core.Role, error) {
	agent := kind == core.KindAgent
	role := core.Role(s)
	if s == "" {
		role = core.RoleMember
	}
	allowed := []string{string(core.RoleMember), string(core.RoleAdmin), string(core.RoleOwner)}
	if agent {
		allowed = allowed[:2]
	}
	if !slices.Contains(allowed, string(role)) {
		e := oneOf("role", "role", s, allowed)
		if agent && role == core.RoleOwner {
			e.Message = "an agent can be a member or an admin; the owner role is for people"
		}
		return role, e
	}
	// Nobody hands out more access than they have: not a higher role, and
	// not the owner's, which reaches every project, from a reach of some.
	if !c.system && !c.actor.Role.AtLeast(role) {
		return role, forbidden("you are a %s and cannot give the %s role", c.actor.Role, role)
	}
	if !c.system && role == core.RoleOwner && len(c.scope.Projects) > 0 {
		return role, forbidden("you reach only some projects here, so you cannot give the owner role, which reaches them all")
	}
	return role, nil
}

// memberAdd makes a person with an account a member, or brings back one
// removed earlier.
func memberAdd(c *cx, a memberAddArgs) error {
	role, err := c.roleArg(a.Role, core.KindPerson)
	if err != nil {
		return err
	}
	var u core.User
	if strings.Contains(a.User, "@") && !strings.HasPrefix(a.User, "@") {
		there, err := store.Find(c.ctx, c.tx, &u, store.Eq("email", strings.ToLower(strings.TrimSpace(a.User))), store.Live)
		if err != nil {
			return err
		}
		if !there {
			e := notFound("account", a.User)
			e.Field, e.Message = "user", "nobody has an account with "+a.User+"; send them an invitation instead"
			return e
		}
	} else if err := c.tx.Get(c.ctx, &u, store.Eq("id", a.User), store.Live); err != nil {
		return missing(err, "user", a.User)
	}
	if u.Kind != core.KindPerson {
		return invalid("user", "agents are created in their workspace with agent.create, not added")
	}
	handle := a.Handle
	if handle == "" {
		if handle, err = c.freeHandle(handleFrom(u.Name, u.Email)); err != nil {
			return err
		}
	}
	if err := checkHandle(handle); err != nil {
		return err
	}
	// Someone removed earlier comes back on their old row.
	var old core.Member
	returning, err := store.Find(c.ctx, c.tx, &old, store.Eq("user_id", u.ID))
	if err != nil {
		return err
	}
	if returning {
		if old.RemovedAt == 0 {
			return conflictErr("%s is already a member", u.Name)
		}
		if _, err := c.tx.Delete(c.ctx, "members", store.Eq("user_id", u.ID)); err != nil {
			return err
		}
	}
	scope, err := c.scopeArg(a.Scope, nil)
	if err != nil {
		return err
	}
	if scope != nil && len(scope.Projects) == 0 && !scope.ReadOnly {
		scope = nil
	}
	return c.addMember(core.Member{WorkspaceID: c.ws, UserID: u.ID, Role: role, Handle: handle, Kind: u.Kind, Name: u.Name,
		Avatar: u.Avatar, Tint: old.Tint, Title: a.Title, Scope: c.capScope(scope), CreatedAt: c.at})
}

func (c *cx) addMember(m core.Member) error {
	// A member coming back keeps the tint it had; anyone else gets the one used least.
	if m.Tint == 0 {
		tint, err := leastUsedTint(c.ctx, c.tx)
		if err != nil {
			return err
		}
		m.Tint = tint
	}
	seq := c.tx.NextSeq()
	m.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, m); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return conflictErr("the handle @%s is taken, or this user is already a member", m.Handle)
		}
		return err
	}
	return c.created(seq, "member", m.UserID, inWorkspace(c.ws), m)
}

// leastUsedTint is the tint a new member of the workspace gets: the one
// its current members use least, the first of those in the palette's
// order on a tie, so that the first members of a workspace all differ.
func leastUsedTint(ctx context.Context, db store.DB) (int, error) {
	var members []core.Member
	if err := db.List(ctx, &members, store.Where(store.Null("removed_at"))); err != nil {
		return 0, err
	}
	used := make([]int, core.MemberTints+1)
	for _, m := range members {
		if m.Tint >= 1 && m.Tint <= core.MemberTints {
			used[m.Tint]++
		}
	}
	best := 1
	for tint := 2; tint <= core.MemberTints; tint++ {
		if used[tint] < used[best] {
			best = tint
		}
	}
	return best, nil
}

var handleStrip = regexp.MustCompile(`[^a-z0-9_-]+`)

// handleFrom suggests an @handle from a name or an email address.
func handleFrom(name, email string) string {
	h := handleStrip.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	h = strings.Trim(h, "-_")
	if len(h) < 2 && email != "" {
		h = handleStrip.ReplaceAllString(strings.ToLower(strings.SplitN(email, "@", 2)[0]), "-")
	}
	if len(h) < 2 {
		h = "member"
	}
	if len(h) > 32 {
		h = h[:32]
	}
	return h
}

// freeHandle returns want, or want with a number added, whichever no member
// of the workspace uses yet.
func (c *cx) freeHandle(want string) (string, error) {
	h := want
	for i := 2; i < 1000; i++ {
		n, err := c.tx.Count(c.ctx, "members", store.Eq("handle", h), store.Null("removed_at"))
		if err != nil {
			return "", err
		}
		if n == 0 {
			return h, nil
		}
		h = want + strconv.Itoa(i)
		if len(h) > 32 {
			h = want[:32-len(strconv.Itoa(i))] + strconv.Itoa(i)
		}
	}
	return "", conflictErr("no free handle like @%s", want)
}

type memberUpdateArgs struct {
	ID        string      `json:"id" quadit:"required,handler"` // id or @handle
	Role      Opt[string] `json:"role"`
	Handle    Opt[string] `json:"handle"`
	Title     Opt[string] `json:"title"`
	Suspended Opt[bool]   `json:"suspended"`
	// Scope limits a person to some projects, or to reading; null lifts
	// it. (An agent's limits are set with agent.update.)
	Scope Opt[scopeArgs] `json:"scope"`
}

// guardMember refuses changes to members the actor may not manage.
func (c *cx) guardMember(m core.Member) error {
	if c.system {
		return nil
	}
	if m.Role == core.RoleOwner && c.actor.Role != core.RoleOwner {
		return forbidden("only an owner can change an owner")
	}
	return nil
}

// lastOwner reports whether m is the only owner left.
func (c *cx) lastOwner(m core.Member) (bool, error) {
	if m.Role != core.RoleOwner {
		return false, nil
	}
	n, err := c.tx.Count(c.ctx, "members", store.Eq("role", string(core.RoleOwner)), store.Null("removed_at"), store.Null("suspended_at"))
	return n <= 1, err
}

func (c *cx) saveMember(m core.Member, p *patch) error {
	c.ref = m.UserID
	if p.empty() {
		return nil
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"] = seq
	if _, err := c.tx.Update(c.ctx, "members", p.set, store.Eq("user_id", m.UserID)); err != nil {
		if h, ok := p.set["handle"].(string); ok && errors.Is(err, store.ErrConflict) {
			return conflictErr("the handle @%s is taken", h)
		}
		return err
	}
	return c.emit(event{seq: seq, typ: "member.updated", entity: "member", entityID: m.UserID, place: inWorkspace(c.ws), data: core.EventData{ID: m.UserID, Changes: p.changes}})
}

// memberUpdate changes a member's role, limits, handle, title, or suspends
// them.
func memberUpdate(c *cx, a memberUpdateArgs) error {
	m, err := c.memberRef("id", a.ID)
	if err != nil {
		return err
	}
	if err := c.guardMember(m); err != nil {
		return err
	}
	if !c.system && c.actor.Kind == core.KindAgent && m.UserID == c.actor.UserID && (a.Role.Set || a.Suspended.Set || a.Scope.Set) {
		return forbidden("an agent cannot change its own role or limits; the person responsible for it can")
	}
	p := newPatch()
	for _, step := range []func(*patch, memberUpdateArgs, core.Member) error{c.memberScope, c.memberRole, memberHandle, c.memberSuspended} {
		if err := step(p, a, m); err != nil {
			return err
		}
	}
	p.setText("title", a.Title, &m.Title)
	return c.saveMember(m, p)
}

// memberScope applies a person's new limits: the projects they reach, and
// whether they may only read.
func (c *cx) memberScope(p *patch, a memberUpdateArgs, m core.Member) error {
	if !a.Scope.Set {
		return nil
	}
	if m.Kind == core.KindAgent {
		return invalid("scope", "an agent's limits are set with agent.update")
	}
	if m.Role == core.RoleOwner && !a.Scope.Null {
		return invalid("scope", "an owner sees the whole workspace; change their role first")
	}
	var sc *core.Scope
	if !a.Scope.Null {
		var err error
		if sc, err = c.scopeArg(&a.Scope.V, m.Scope); err != nil {
			return err
		}
		if sc != nil && len(sc.NeedsApproval) > 0 {
			return invalid("scope.needs_approval", "approvals are for agents; a person's scope is projects and read-only")
		}
	}
	sc = c.capScope(sc)
	p.set["scope"] = sc
	p.changes["scope"] = core.FieldChange{From: m.Scope, To: sc}
	return nil
}

// memberRole applies a new role, keeping an owner on the workspace and an
// agent from raising another above itself.
func (c *cx) memberRole(p *patch, a memberUpdateArgs, m core.Member) error {
	if !a.Role.Set || core.Role(a.Role.V) == m.Role {
		return nil
	}
	role, err := c.roleArg(a.Role.V, m.Kind)
	if err != nil {
		return err
	}
	if !c.system && c.actor.Kind == core.KindAgent && role.AtLeast(c.actor.Role) && role != c.actor.Role {
		return forbidden("an agent cannot give a role above its own")
	}
	last, err := c.lastOwner(m)
	if err != nil {
		return err
	}
	if last {
		return conflictErr("a workspace needs an owner: make someone else an owner first")
	}
	p.put("role", string(m.Role), string(role))
	return nil
}

// memberHandle puts a new @handle in the patch, once it is checked; the
// same handle again changes nothing.
func memberHandle(p *patch, a memberUpdateArgs, m core.Member) error {
	if !a.Handle.Set || a.Handle.V == m.Handle {
		return nil
	}
	if err := checkHandle(a.Handle.V); err != nil {
		return err
	}
	p.put("handle", m.Handle, a.Handle.V)
	return nil
}

// memberSuspended suspends a member, or lets them back; the only owner
// cannot be suspended.
func (c *cx) memberSuspended(p *patch, a memberUpdateArgs, m core.Member) error {
	if a.Suspended.Set && a.Suspended.V && m.SuspendedAt == 0 {
		last, err := c.lastOwner(m)
		if err != nil {
			return err
		}
		if last {
			return conflictErr("the only owner cannot be suspended")
		}
	}
	p.setStamp("suspended_at", a.Suspended, m.SuspendedAt, c.at)
	return nil
}

type memberRefArgs struct {
	ID string `json:"id" quadit:"required,handler"`
}

// memberRemove takes a member out of the workspace. Their history stays
// under their name; tasks they held are left unassigned.
func memberRemove(c *cx, a memberRefArgs) error {
	m, err := c.memberRef("id", a.ID)
	if err != nil {
		return err
	}
	if err := c.guardMember(m); err != nil {
		return err
	}
	if last, err := c.lastOwner(m); err != nil {
		return err
	} else if last {
		return conflictErr("the only owner cannot be removed")
	}
	p := newPatch()
	p.put("removed_at", int64(0), c.at)
	if err := c.saveMember(m, p); err != nil {
		return err
	}
	if _, err := c.tx.Update(c.ctx, "api_tokens", map[string]any{"revoked_at": c.at}, store.Eq("user_id", m.UserID), store.Null("revoked_at")); err != nil {
		return err
	}
	return c.eachTask(store.TaskFilter{AssigneeIDs: []string{m.UserID}, Open: true}, func(t core.Task) error {
		tp := newPatch()
		tp.put("assignee_id", t.AssigneeID, "")
		return c.saveOther(t, tp, core.EventData{})
	})
}

// scopeArgs sets limits. In an update, a part that is left out stays as it
// was: narrowing the projects does not lift read-only, and the other way
// round. An empty list clears that part; "scope": null lifts all of it.
type scopeArgs struct {
	Projects      []string `json:"projects"` // keys or ids; empty = all
	ReadOnly      *bool    `json:"read_only"`
	NeedsApproval []string `json:"needs_approval"`
}

// scopeArg reads limits, on top of the ones there already (nil for a new
// member).
func (c *cx) scopeArg(a *scopeArgs, base *core.Scope) (*core.Scope, error) {
	if a == nil {
		return nil, nil
	}
	s := &core.Scope{}
	if base != nil {
		s.ReadOnly = base.ReadOnly
		if a.Projects == nil {
			s.Projects = append([]string(nil), base.Projects...)
		}
		if a.NeedsApproval == nil {
			s.NeedsApproval = append([]string(nil), base.NeedsApproval...)
		}
	}
	if a.ReadOnly != nil {
		s.ReadOnly = *a.ReadOnly
	}
	for _, ref := range a.Projects {
		project, err := c.project(ref)
		if err != nil {
			return nil, err
		}
		s.Projects = append(s.Projects, project.ID)
	}
	for _, t := range a.NeedsApproval {
		if _, ok := handlers[t]; !ok {
			return nil, oneOf("scope.needs_approval", "change type", t, ChangeTypes())
		}
		s.NeedsApproval = append(s.NeedsApproval, t)
	}
	if len(s.Projects) == 0 && !s.ReadOnly && len(s.NeedsApproval) == 0 {
		return nil, nil
	}
	return s, nil
}

// checkHandle checks an @handle: what people type to mention someone.
func checkHandle(h string) error {
	if len(h) < 2 || len(h) > 32 {
		return invalid("handle", "a handle is 2 to 32 characters")
	}
	for _, r := range h {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return invalid("handle", "a handle uses lower-case letters, digits, - and _ only: %q", h)
		}
	}
	return nil
}
