package engine

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("workspace.update", core.RoleAdmin, workspaceUpdate)
	register("member.add", core.RoleAdmin, memberAdd)
	register("member.update", core.RoleAdmin, memberUpdate)
	register("member.remove", core.RoleAdmin, memberRemove)
	register("agent.create", core.RoleAdmin, agentCreate)
	register("agent.update", core.RoleAdmin, agentUpdate)
	register("project.create", core.RoleAdmin, projectCreate)
	register("project.update", core.RoleAdmin, projectUpdate)
	register("project.delete", core.RoleAdmin, projectDelete)
	register("status.create", core.RoleAdmin, statusCreate)
	register("status.update", core.RoleAdmin, statusUpdate)
	register("status.delete", core.RoleAdmin, statusDelete)
	register("label.create", core.RoleMember, labelCreate)
	// Anyone tags with a new label; renaming or removing one changes it for
	// everybody, which is an admin's call.
	register("label.update", core.RoleAdmin, labelUpdate)
	register("label.delete", core.RoleAdmin, labelDelete)
	register("workspace.delete", core.RoleOwner, workspaceDelete)
}

// nextRank returns a rank after the last row matching conds.
func nextRank[T any](c *cx, conds ...store.Cond) (string, error) {
	var rows []T
	if err := c.tx.List(c.ctx, &rows, store.Q{Where: conds, Order: "-rank", Limit: 1}); err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return rank.ForNumber(1), nil
	}
	return rank.After(reflect.ValueOf(rows[0]).FieldByName("Rank").String()), nil
}

// rankArg applies an optional rank argument to a patch.
func (p *patch) rank(o Opt[string], cur *string) error {
	if !o.Set {
		return nil
	}
	if o.Null || !rank.Valid(o.V) {
		return invalid("rank", "%q is not a rank", o.V)
	}
	p.str("rank", o, cur)
	return nil
}

// ---- bootstrap ----

// BootstrapArgs describe a new workspace and the person who owns it.
type BootstrapArgs struct {
	OwnerID       string // an existing user; or the fields below make one
	OwnerName     string
	OwnerEmail    string
	OwnerHandle   string
	WorkspaceSlug string
	WorkspaceName string
}

// Bootstrap makes a workspace and its owner membership, and the owner too
// if they do not exist yet. It is how a new install, or a new workspace on
// one, starts.
func (e *Engine) Bootstrap(ctx context.Context, a BootstrapArgs) (core.Workspace, core.User, error) {
	var ws core.Workspace
	var owner core.User
	at := e.now().UnixMilli()
	if !slugOK(a.WorkspaceSlug) {
		return ws, owner, invalid("workspace_slug", "a slug is 2 to 40 lower-case letters, digits or dashes")
	}
	err := e.st.Atomic(ctx, func(db store.DB) error {
		var err error
		if a.OwnerID != "" {
			err = db.Get(ctx, &owner, store.Eq("id", a.OwnerID), store.Live)
		} else {
			email := strings.ToLower(strings.TrimSpace(a.OwnerEmail))
			if email == "" || !strings.Contains(email, "@") {
				return invalid("owner_email", "an owner needs an email address")
			}
			err = db.Get(ctx, &owner, store.Eq("email", email), store.Live)
			if errors.Is(err, store.ErrNotFound) {
				owner = core.User{ID: id.New(), Kind: core.KindPerson, Name: strings.TrimSpace(a.OwnerName), Email: email, CreatedAt: at, UpdatedAt: at}
				if owner.Name == "" {
					return invalid("owner_name", "an owner needs a name")
				}
				// The first person on an install runs it.
				if n, cerr := db.Count(ctx, "users", store.Eq("kind", core.KindPerson)); cerr == nil && n == 0 {
					owner.IsAdmin = true
				}
				err = db.Insert(ctx, owner)
			}
		}
		if err != nil {
			return err
		}
		if owner.Kind != core.KindPerson {
			return invalid("owner", "a workspace is owned by a person")
		}
		handle := a.OwnerHandle
		if handle == "" {
			handle = handleFrom(owner.Name, owner.Email)
		}
		if err := checkHandle(handle); err != nil {
			return err
		}
		ws = core.Workspace{ID: id.New(), Slug: a.WorkspaceSlug, Name: strings.TrimSpace(a.WorkspaceName), CreatedAt: at, UpdatedAt: at}
		if ws.Name == "" {
			ws.Name = ws.Slug
		}
		if err := db.Insert(ctx, ws); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return &Error{Code: CodeConflict, Field: "slug", Message: "a workspace with the address \"" + ws.Slug + "\" already exists; choose another"}
			}
			return err
		}
		return db.Insert(ctx, core.Member{WorkspaceID: ws.ID, UserID: owner.ID, Role: core.RoleOwner, Handle: handle,
			Kind: owner.Kind, Name: owner.Name, Avatar: owner.Avatar, CreatedAt: at})
	})
	return ws, owner, err
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
		h = want + itoa(i)
		if len(h) > 32 {
			h = want[:32-len(itoa(i))] + itoa(i)
		}
	}
	return "", conflictErr("no free handle like @%s", want)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// ---- workspace ----

type workspaceUpdateArgs struct {
	Name     Opt[string]          `json:"name"`
	Icon     Opt[string]          `json:"icon"`
	Settings Opt[json.RawMessage] `json:"settings"`
}

func workspaceUpdate(c *cx) error {
	var a workspaceUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	var w core.Workspace
	if err := c.tx.Get(c.ctx, &w, store.Eq("id", c.ws)); err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &w.Name); err != nil {
		return err
	}
	p.str("icon", a.Icon, &w.Icon)
	if a.Settings.Set {
		if !json.Valid(a.Settings.V) {
			return invalid("settings", "settings must be a JSON object")
		}
		p.put("settings", string(w.Settings), string(a.Settings.V))
	}
	if p.empty() {
		return nil
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "workspaces", p.set, store.Eq("id", c.ws)); err != nil {
		return err
	}
	return c.emit(seq, "workspace.updated", "workspace", c.ws, "workspace", c.ws, "", map[string]any{"id": c.ws, "changes": p.changes})
}

// ---- members and agents ----

type memberAddArgs struct {
	User   string `json:"user"` // an existing person: their id or their email
	Handle string `json:"handle"`
	Role   string `json:"role"`
	Title  string `json:"title"`
	// Scope limits the person to some projects, or to reading.
	Scope *scopeArgs `json:"scope"`
}

func (c *cx) roleArg(s string, agent bool) (core.Role, error) {
	role := core.Role(s)
	if s == "" {
		role = core.RoleMember
	}
	allowed := []string{string(core.RoleMember), string(core.RoleAdmin), string(core.RoleOwner)}
	if agent {
		allowed = allowed[:2]
	}
	if !contains(allowed, string(role)) {
		e := oneOf("role", "role", s, allowed)
		if agent && role == core.RoleOwner {
			e.Message = "an agent can be a member or an admin; the owner role is for people"
		}
		return role, e
	}
	// Nobody hands out more access than they have.
	if !c.system && !c.actor.Role.AtLeast(role) {
		return role, forbidden("you are a %s and cannot give the %s role", c.actor.Role, role)
	}
	return role, nil
}

func memberAdd(c *cx) error {
	var a memberAddArgs
	if err := c.args(&a); err != nil {
		return err
	}
	role, err := c.roleArg(a.Role, false)
	if err != nil {
		return err
	}
	var u core.User
	if strings.Contains(a.User, "@") && !strings.HasPrefix(a.User, "@") {
		if err := c.tx.Get(c.ctx, &u, store.Eq("email", strings.ToLower(strings.TrimSpace(a.User))), store.Live); err != nil {
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
	if err := c.tx.Get(c.ctx, &old, store.Eq("user_id", u.ID)); err == nil {
		if old.RemovedAt == 0 {
			return conflictErr("%s is already a member", u.Name)
		}
		if _, err := c.tx.Delete(c.ctx, "members", store.Eq("user_id", u.ID)); err != nil {
			return err
		}
	}
	scope, err := c.scopeArg(a.Scope)
	if err != nil {
		return err
	}
	if scope != nil && len(scope.Projects) == 0 && !scope.ReadOnly {
		scope = nil
	}
	return c.addMember(core.Member{WorkspaceID: c.ws, UserID: u.ID, Role: role, Handle: handle, Kind: u.Kind, Name: u.Name,
		Avatar: u.Avatar, Title: a.Title, Scope: c.capScope(scope), CreatedAt: c.at})
}

func (c *cx) addMember(m core.Member) error {
	seq := c.tx.NextSeq()
	m.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, m); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return conflictErr("the handle @%s is taken, or this user is already a member", m.Handle)
		}
		return err
	}
	return c.created(seq, "member", m.UserID, "workspace", c.ws, "", m)
}

type memberUpdateArgs struct {
	ID        string      `json:"id"` // id or @handle
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
		if errors.Is(err, store.ErrConflict) {
			return conflictErr("that handle is taken")
		}
		return err
	}
	return c.emit(seq, "member.updated", "member", m.UserID, "workspace", c.ws, "", map[string]any{"id": m.UserID, "changes": p.changes})
}

func memberUpdate(c *cx) error {
	var a memberUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
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
	if a.Scope.Set {
		if m.Kind == core.KindAgent {
			return invalid("scope", "an agent's limits are set with agent.update")
		}
		if m.Role == core.RoleOwner && !a.Scope.Null {
			return invalid("scope", "an owner sees the whole workspace; change their role first")
		}
		var sc *core.Scope
		if !a.Scope.Null {
			if sc, err = c.scopeArg(&a.Scope.V); err != nil {
				return err
			}
			if len(sc.NeedsApproval) > 0 {
				return invalid("scope.needs_approval", "approvals are for agents; a person's scope is projects and read-only")
			}
			if len(sc.Projects) == 0 && !sc.ReadOnly {
				sc = nil
			}
		}
		sc = c.capScope(sc)
		p.set["scope"] = sc
		p.changes["scope"] = core.FieldChange{From: m.Scope, To: sc}
	}
	if a.Role.Set && core.Role(a.Role.V) != m.Role {
		role, err := c.roleArg(a.Role.V, m.Kind == core.KindAgent)
		if err != nil {
			return err
		}
		if !c.system && c.actor.Kind == core.KindAgent && role.AtLeast(c.actor.Role) && role != c.actor.Role {
			return forbidden("an agent cannot give a role above its own")
		}
		if last, err := c.lastOwner(m); err != nil {
			return err
		} else if last {
			return conflictErr("a workspace needs an owner: make someone else an owner first")
		}
		p.put("role", string(m.Role), string(role))
	}
	if a.Handle.Set && a.Handle.V != m.Handle {
		if err := checkHandle(a.Handle.V); err != nil {
			return err
		}
		p.put("handle", m.Handle, a.Handle.V)
	}
	p.str("title", a.Title, &m.Title)
	if a.Suspended.Set {
		if a.Suspended.V && m.SuspendedAt == 0 {
			if last, err := c.lastOwner(m); err != nil {
				return err
			} else if last {
				return conflictErr("the only owner cannot be suspended")
			}
			p.put("suspended_at", int64(0), c.at)
		} else if !a.Suspended.V && m.SuspendedAt != 0 {
			p.put("suspended_at", m.SuspendedAt, int64(0))
		}
	}
	return c.saveMember(m, p)
}

type memberRefArgs struct {
	ID string `json:"id"`
}

// memberRemove takes a member out of the workspace. Their history stays
// under their name; tasks they held are left unassigned.
func memberRemove(c *cx) error {
	var a memberRefArgs
	if err := c.args(&a); err != nil {
		return err
	}
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
	open, err := c.tx.Tasks(c.ctx, store.TaskFilter{AssigneeIDs: []string{m.UserID}, Open: true, Limit: 5000})
	if err != nil {
		return err
	}
	for _, t := range open {
		tp := newPatch()
		tp.put("assignee_id", t.AssigneeID, "")
		if err := c.saveTask(t, tp, nil); err != nil {
			return err
		}
	}
	return nil
}

type scopeArgs struct {
	Projects      []string `json:"projects"` // keys or ids; empty = all
	ReadOnly      bool     `json:"read_only"`
	NeedsApproval []string `json:"needs_approval"`
}

func (c *cx) scopeArg(a *scopeArgs) (*core.Scope, error) {
	if a == nil {
		return nil, nil
	}
	s := &core.Scope{ReadOnly: a.ReadOnly}
	for _, ref := range a.Projects {
		p, err := c.project(ref)
		if err != nil {
			return nil, err
		}
		s.Projects = append(s.Projects, p.ID)
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

type agentCreateArgs struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Handle      string       `json:"handle"`
	Description string       `json:"description"`
	Avatar      string       `json:"avatar"`
	Role        string       `json:"role"`        // member (default) or admin
	Responsible string       `json:"responsible"` // the person who answers for it; default: the caller
	Scope       *scopeArgs   `json:"scope"`
	Budget      *core.Budget `json:"budget"`
}

func agentCreate(c *cx) error {
	var a agentCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	uid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(a.Name)
	if name == "" {
		return invalid("name", "an agent needs a name")
	}
	handle := a.Handle
	if handle == "" {
		if handle, err = c.freeHandle(handleFrom(name, "")); err != nil {
			return err
		}
	}
	if err := checkHandle(handle); err != nil {
		return err
	}
	role, err := c.roleArg(a.Role, true)
	if err != nil {
		return err
	}
	// Someone answers for every agent. By default that is the person who
	// creates it; an agent that creates another passes on its own.
	responsible := c.actor.UserID
	if a.Responsible != "" {
		if responsible, err = c.optMember("responsible", a.Responsible); err != nil {
			return err
		}
	} else if c.actor.Kind == core.KindAgent {
		var self core.User
		if err := c.tx.Get(c.ctx, &self, store.Eq("id", c.actor.UserID)); err != nil {
			return err
		}
		responsible = self.ResponsibleID
	}
	rm, err := c.memberRef("responsible", responsible)
	if err != nil {
		return err
	}
	if rm.Kind != core.KindPerson {
		return invalid("responsible", "the one responsible for an agent must be a person, not another agent")
	}
	scope, err := c.scopeArg(a.Scope)
	if err != nil {
		return err
	}
	scope = c.capScope(scope)
	u := core.User{ID: uid, Kind: core.KindAgent, Name: name, Description: a.Description, Avatar: a.Avatar, WorkspaceID: c.ws,
		ResponsibleID: rm.UserID, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	if err := c.tx.Insert(c.ctx, u); err != nil {
		return taken(err, "id", uid)
	}
	return c.addMember(core.Member{WorkspaceID: c.ws, UserID: uid, Role: role, Handle: handle, Kind: u.Kind, Name: u.Name,
		Avatar: u.Avatar, Title: a.Description, Scope: scope, Budget: a.Budget, CreatedAt: c.at, ResponsibleID: rm.UserID})
}

// capScope holds a scope an agent hands out to the agent's own: an agent
// made or changed by an agent never reaches further than its maker. What a
// person sets is taken as given.
func (c *cx) capScope(scope *core.Scope) *core.Scope {
	if c.system || c.actor.Kind != core.KindAgent || c.actor.Scope == nil {
		return scope
	}
	if scope == nil {
		scope = &core.Scope{}
	}
	mine := c.actor.Scope
	if len(mine.Projects) > 0 {
		scope.Projects = narrow(mine.Projects, orAll(scope.Projects, mine.Projects))
	}
	scope.ReadOnly = scope.ReadOnly || mine.ReadOnly
	for _, t := range mine.NeedsApproval {
		if !contains(scope.NeedsApproval, t) {
			scope.NeedsApproval = append(scope.NeedsApproval, t)
		}
	}
	return scope
}

func orAll(list, all []string) []string {
	if len(list) == 0 {
		return all
	}
	return list
}

type agentUpdateArgs struct {
	ID          string           `json:"id"`
	Name        Opt[string]      `json:"name"`
	Description Opt[string]      `json:"description"`
	Avatar      Opt[string]      `json:"avatar"`
	Responsible Opt[string]      `json:"responsible"`
	Scope       Opt[scopeArgs]   `json:"scope"`
	Budget      Opt[core.Budget] `json:"budget"`
}

func agentUpdate(c *cx) error {
	var a agentUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	m, err := c.memberRef("id", a.ID)
	if err != nil {
		return err
	}
	if m.Kind != core.KindAgent {
		return invalid("id", "@%s is a person; people edit their own profile", m.Handle)
	}
	p := newPatch()
	userSet := map[string]any{}
	if err := p.name("name", a.Name, &m.Name); err != nil {
		return err
	}
	if _, ok := p.set["name"]; ok {
		userSet["name"] = m.Name
	}
	if a.Description.Set {
		p.str("title", a.Description, &m.Title)
		userSet["description"] = m.Title
	}
	if a.Avatar.Set {
		p.str("avatar", a.Avatar, &m.Avatar)
		userSet["avatar"] = m.Avatar
	}
	if a.Responsible.Set {
		rm, err := c.memberRef("responsible", a.Responsible.V)
		if err != nil {
			return err
		}
		if rm.Kind != core.KindPerson {
			return invalid("responsible", "the one responsible for an agent must be a person")
		}
		userSet["responsible_id"] = rm.UserID
		p.changes["responsible_id"] = core.FieldChange{To: rm.UserID}
	}
	if !c.system && c.actor.Kind == core.KindAgent && m.UserID == c.actor.UserID && (a.Scope.Set || a.Budget.Set) {
		return forbidden("an agent cannot change its own role, limits or budget; the person responsible for it can")
	}
	if a.Scope.Set {
		var sc *core.Scope
		if !a.Scope.Null {
			if sc, err = c.scopeArg(&a.Scope.V); err != nil {
				return err
			}
		}
		sc = c.capScope(sc)
		p.set["scope"] = sc
		p.changes["scope"] = core.FieldChange{From: m.Scope, To: sc}
	}
	if a.Budget.Set {
		var b *core.Budget
		if !a.Budget.Null && (a.Budget.V.CostMicros > 0 || a.Budget.V.Minutes > 0) {
			b = &a.Budget.V
		}
		p.set["budget"] = b
		p.changes["budget"] = core.FieldChange{From: m.Budget, To: b}
	}
	if len(userSet) > 0 {
		userSet["updated_at"] = c.at
		if _, err := c.tx.Update(c.ctx, "users", userSet, store.Eq("id", m.UserID)); err != nil {
			return err
		}
	}
	return c.saveMember(m, p)
}

// ---- projects ----

var projectKeyRE = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

type projectCreateArgs struct {
	ID          string                `json:"id"`
	Key         string                `json:"key"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Icon        string                `json:"icon"`
	Color       string                `json:"color"`
	Lead        string                `json:"lead"`
	Settings    *core.ProjectSettings `json:"settings"`
}

// defaultStatuses is what a new project starts with. "Waiting" is its own
// category so "who has the next move" is visible on every board.
var defaultStatuses = []struct{ name, category, color string }{
	{"Backlog", core.CatBacklog, "#9ca3af"},
	{"Todo", core.CatUnstarted, "#6b7280"},
	{"In Progress", core.CatStarted, "#f59e0b"},
	{"Waiting", core.CatWaiting, "#8b5cf6"},
	{"Done", core.CatDone, "#10b981"},
	{"Canceled", core.CatCanceled, "#ef4444"},
}

func projectCreate(c *cx) error {
	var a projectCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	a.Key = strings.ToUpper(strings.TrimSpace(a.Key))
	if !projectKeyRE.MatchString(a.Key) {
		return invalid("key", "a project key is 2 to 10 upper-case letters or digits, starting with a letter (it prefixes task numbers: SVA-12)")
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a project needs a name")
	}
	lead, err := c.optMember("lead", a.Lead)
	if err != nil {
		return err
	}
	rk, err := nextRank[core.Project](c, store.Live)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	p := core.Project{ID: pid, WorkspaceID: c.ws, Key: a.Key, Name: strings.TrimSpace(a.Name), Description: a.Description,
		Icon: a.Icon, Color: a.Color, LeadID: lead, Rank: rk, Settings: a.Settings,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, CreatedSeq: seq, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, p); err != nil {
		return taken(err, "project key", a.Key)
	}
	if err := c.created(seq, "project", p.ID, "project", p.ID, p.ID, p); err != nil {
		return err
	}
	for i, d := range defaultStatuses {
		seq := c.tx.NextSeq()
		st := core.Status{ID: id.New(), WorkspaceID: c.ws, ProjectID: p.ID, Name: d.name, Color: d.color, Category: d.category,
			Rank: rank.ForNumber(i + 1), IsDefault: d.category == core.CatUnstarted, CreatedAt: c.at, UpdatedSeq: seq}
		if err := c.tx.Insert(c.ctx, st); err != nil {
			return err
		}
		if err := c.emit(seq, "status.created", "status", st.ID, "project", p.ID, p.ID, map[string]any{"row": st}); err != nil {
			return err
		}
	}
	c.ref, c.key = p.ID, p.Key
	return c.startCycles(p)
}

// startCycles makes a project's first cycles as soon as cycles are on, so
// there is a current one to put work in straight away.
func (c *cx) startCycles(p core.Project) error {
	if p.Settings == nil || !p.Settings.Cycles {
		return nil
	}
	if p.Settings.CycleDays <= 0 {
		p.Settings.CycleDays = 14
	}
	ref, key := c.ref, c.key
	err := c.rollProject(p, time.UnixMilli(c.at).UTC().Format("2006-01-02"))
	c.ref, c.key = ref, key
	return err
}

type projectUpdateArgs struct {
	ID          string                    `json:"id"`
	Key         Opt[string]               `json:"key"`
	Name        Opt[string]               `json:"name"`
	Description Opt[string]               `json:"description"`
	Icon        Opt[string]               `json:"icon"`
	Color       Opt[string]               `json:"color"`
	Lead        Opt[string]               `json:"lead"`
	Rank        Opt[string]               `json:"rank"`
	Settings    Opt[core.ProjectSettings] `json:"settings"`
	Archived    Opt[bool]                 `json:"archived"`
}

func projectUpdate(c *cx) error {
	var a projectUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pr, err := c.project(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	oldKey := pr.Key
	if a.Key.Set {
		a.Key.V = strings.ToUpper(strings.TrimSpace(a.Key.V))
		if !projectKeyRE.MatchString(a.Key.V) {
			return invalid("key", "a project key is 2 to 10 upper-case letters or digits, starting with a letter")
		}
		p.str("key", a.Key, &pr.Key)
	}
	if err := p.name("name", a.Name, &pr.Name); err != nil {
		return err
	}
	p.str("description", a.Description, &pr.Description)
	p.str("icon", a.Icon, &pr.Icon)
	p.str("color", a.Color, &pr.Color)
	if a.Lead.Set {
		lead := ""
		if !a.Lead.Null {
			if lead, err = c.optMember("lead", a.Lead.V); err != nil {
				return err
			}
		}
		p.put("lead_id", pr.LeadID, lead)
	}
	if err := p.rank(a.Rank, &pr.Rank); err != nil {
		return err
	}
	if a.Settings.Set {
		s := a.Settings.V
		if s.Cycles && s.CycleDays == 0 {
			s.CycleDays = 14
		}
		if s.CycleDays < 0 || s.CycleDays > 90 || s.CycleStart < 0 || s.CycleStart > 6 {
			return invalid("settings", "cycle_days is 1 to 90 and cycle_start is a weekday, 0 (Sunday) to 6")
		}
		var old core.ProjectSettings
		if pr.Settings != nil {
			old = *pr.Settings
		}
		if old != s {
			p.set["settings"] = &s
			p.changes["settings"] = core.FieldChange{From: pr.Settings, To: &s}
		}
	}
	if a.Archived.Set {
		if a.Archived.V && pr.ArchivedAt == 0 {
			p.put("archived_at", int64(0), c.at)
		} else if !a.Archived.V && pr.ArchivedAt != 0 {
			p.put("archived_at", pr.ArchivedAt, int64(0))
		}
	}
	if !p.empty() {
		p.set["updated_at"] = c.at
	}
	if err := c.save(p, "projects", "project", pr.ID, "project", pr.ID, pr.ID, nil); err != nil {
		return taken(err, "project key", pr.Key)
	}
	if pr.Key != oldKey {
		// Task keys follow the project key. The old keys stop resolving.
		tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{ProjectIDs: []string{pr.ID}, Archived: true, Limit: 5000})
		if err != nil {
			return err
		}
		trashed, err := c.tx.Tasks(c.ctx, store.TaskFilter{ProjectIDs: []string{pr.ID}, InTrash: true, Limit: 5000})
		if err != nil {
			return err
		}
		for _, t := range append(tasks, trashed...) {
			if _, err := c.tx.Update(c.ctx, "tasks", map[string]any{"key": pr.Key + "-" + itoa(t.Number)}, store.Eq("id", t.ID)); err != nil {
				return err
			}
		}
	}
	c.key = pr.Key
	if sp, ok := p.set["settings"].(*core.ProjectSettings); ok {
		pr.Settings = sp
		return c.startCycles(pr)
	}
	return nil
}

func projectDelete(c *cx) error {
	var a memberRefArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pr, err := c.project(a.ID)
	if err != nil {
		return err
	}
	return c.trash("projects", "project", pr.ID, "project", pr.ID, pr.ID, map[string]any{"key": pr.Key})
}

// ---- statuses ----

type statusCreateArgs struct {
	ID       string `json:"id"`
	Project  string `json:"project"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Color    string `json:"color"`
	Rank     string `json:"rank"`
}

func statusCreate(c *cx) error {
	var a statusCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	p, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a status needs a name")
	}
	if !core.ValidCategory(a.Category) {
		return oneOf("category", "category", a.Category, core.Categories)
	}
	rk := a.Rank
	if rk == "" {
		// A new status goes after the last one of its category.
		all, err := c.statuses(p.ID)
		if err != nil {
			return err
		}
		order := map[string]int{}
		for i, k := range core.Categories {
			order[k] = i
		}
		prev, next := "", ""
		for _, s := range all {
			if order[s.Category] <= order[a.Category] {
				prev = s.Rank
			} else if next == "" {
				next = s.Rank
			}
		}
		rk = rank.Between(prev, next)
	} else if !rank.Valid(rk) {
		return invalid("rank", "%q is not a rank", rk)
	}
	seq := c.tx.NextSeq()
	st := core.Status{ID: sid, WorkspaceID: c.ws, ProjectID: p.ID, Name: strings.TrimSpace(a.Name), Color: a.Color,
		Category: a.Category, Rank: rk, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, st); err != nil {
		return taken(err, "status name", st.Name)
	}
	return c.created(seq, "status", st.ID, "project", p.ID, p.ID, st)
}

type statusUpdateArgs struct {
	ID        string      `json:"id"`
	Name      Opt[string] `json:"name"`
	Category  Opt[string] `json:"category"`
	Color     Opt[string] `json:"color"`
	Rank      Opt[string] `json:"rank"`
	IsDefault Opt[bool]   `json:"is_default"`
}

func statusUpdate(c *cx) error {
	var a statusUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	st, err := get[core.Status](c, "status", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &st.Name); err != nil {
		return err
	}
	if a.Category.Set {
		if !core.ValidCategory(a.Category.V) {
			return oneOf("category", "category", a.Category.V, core.Categories)
		}
		p.str("category", a.Category, &st.Category)
	}
	p.str("color", a.Color, &st.Color)
	if err := p.rank(a.Rank, &st.Rank); err != nil {
		return err
	}
	if a.IsDefault.Set && a.IsDefault.V && !st.IsDefault {
		// One default per project: the old one steps down.
		all, err := c.statuses(st.ProjectID)
		if err != nil {
			return err
		}
		for _, o := range all {
			if o.IsDefault {
				op := newPatch()
				op.put("is_default", true, false)
				if err := c.save(op, "statuses", "status", o.ID, "project", st.ProjectID, st.ProjectID, nil); err != nil {
					return err
				}
			}
		}
		p.put("is_default", false, true)
	}
	return taken(c.save(p, "statuses", "status", st.ID, "project", st.ProjectID, st.ProjectID, nil), "status name", st.Name)
}

type statusDeleteArgs struct {
	ID     string `json:"id"`
	MoveTo string `json:"move_to"` // where its tasks go
}

func statusDelete(c *cx) error {
	var a statusDeleteArgs
	if err := c.args(&a); err != nil {
		return err
	}
	st, err := get[core.Status](c, "status", "id", a.ID)
	if err != nil {
		return err
	}
	var pr core.Project
	if err := c.tx.Get(c.ctx, &pr, store.Eq("id", st.ProjectID)); err != nil {
		return err
	}
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{StatusIDs: []string{st.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	trashed, err := c.tx.Tasks(c.ctx, store.TaskFilter{StatusIDs: []string{st.ID}, InTrash: true, Limit: 5000})
	if err != nil {
		return err
	}
	tasks = append(tasks, trashed...)
	if len(tasks) > 0 || st.IsDefault {
		if a.MoveTo == "" {
			return invalid("move_to", "%d tasks have this status: say where they go with move_to", len(tasks))
		}
		to, err := c.status(pr, "move_to", a.MoveTo)
		if err != nil {
			return err
		}
		if to.ID == st.ID {
			return invalid("move_to", "move_to must be another status")
		}
		for _, t := range tasks {
			tp := newPatch()
			c.setStatus(tp, &t, to)
			if err := c.saveTask(t, tp, nil); err != nil {
				return err
			}
		}
		if st.IsDefault {
			op := newPatch()
			op.put("is_default", false, true)
			if err := c.save(op, "statuses", "status", to.ID, "project", pr.ID, pr.ID, nil); err != nil {
				return err
			}
		}
	}
	return c.trash("statuses", "status", st.ID, "project", pr.ID, pr.ID, nil)
}

// ---- labels ----

type labelCreateArgs struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Project     string `json:"project"` // empty = shared by the whole workspace
}

func labelCreate(c *cx) error {
	var a labelCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	lid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a label needs a name")
	}
	scopeType, scopeID, projectID := "workspace", c.ws, ""
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		scopeType, scopeID, projectID = "project", p.ID, p.ID
	}
	seq := c.tx.NextSeq()
	l := core.Label{ID: lid, WorkspaceID: c.ws, ProjectID: projectID, Name: strings.TrimSpace(a.Name), Color: a.Color,
		Description: a.Description, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, l); err != nil {
		return taken(err, "id", lid)
	}
	return c.created(seq, "label", l.ID, scopeType, scopeID, projectID, l)
}

type labelUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Color       Opt[string] `json:"color"`
	Description Opt[string] `json:"description"`
}

func labelScope(c *cx, l core.Label) (string, string) {
	if l.ProjectID != "" {
		return "project", l.ProjectID
	}
	return "workspace", c.ws
}

func labelUpdate(c *cx) error {
	var a labelUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	l, err := get[core.Label](c, "label", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &l.Name); err != nil {
		return err
	}
	p.str("color", a.Color, &l.Color)
	p.str("description", a.Description, &l.Description)
	st, sid := labelScope(c, l)
	return c.save(p, "labels", "label", l.ID, st, sid, l.ProjectID, nil)
}

func labelDelete(c *cx) error {
	var a memberRefArgs
	if err := c.args(&a); err != nil {
		return err
	}
	l, err := get[core.Label](c, "label", "id", a.ID)
	if err != nil {
		return err
	}
	// Tasks drop the label; each says so in its own timeline.
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{LabelIDs: []string{l.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		tp := newPatch()
		if err := c.setLabels(tp, &t, without(t.LabelIDs, l.ID)); err != nil {
			return err
		}
		if err := c.saveTask(t, tp, nil); err != nil {
			return err
		}
	}
	st, sid := labelScope(c, l)
	return c.trash("labels", "label", l.ID, st, sid, l.ProjectID, nil)
}

func without(list []string, v string) []string {
	out := make([]string, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

type workspaceDeleteArgs struct {
	// Confirm must be the workspace's slug, so nothing deletes one by accident.
	Confirm string `json:"confirm"`
}

// workspaceDelete puts the whole workspace in the trash. Nobody can enter
// it from then on; the people who run the install can bring it back for 30
// days, after which it and its files are removed for good.
func workspaceDelete(c *cx) error {
	var a workspaceDeleteArgs
	if err := c.args(&a); err != nil {
		return err
	}
	var w core.Workspace
	if err := c.tx.Get(c.ctx, &w, store.Eq("id", c.ws)); err != nil {
		return err
	}
	if a.Confirm != w.Slug {
		return invalid("confirm", "to delete this workspace, send its slug as confirm: %q", w.Slug)
	}
	if c.actor.Kind != core.KindPerson {
		return forbidden("only a person who owns the workspace can delete it")
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "workspaces", map[string]any{"deleted_at": c.at}, store.Eq("id", c.ws)); err != nil {
		return err
	}
	c.ref = w.ID
	return c.emit(seq, "workspace.deleted", "workspace", w.ID, "workspace", w.ID, "", map[string]any{"id": w.ID, "gone": true, "slug": w.Slug})
}
