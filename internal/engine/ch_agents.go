package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	// Members may make a sub-agent for a task; a standing agent needs an admin.
	register("agent.create", core.RoleMember, agentCreate)
	register("agent.update", core.RoleAdmin, agentUpdate)
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
	// Task makes a sub-agent for one task: any agent or member may make one.
	// It is a member limited to that task's project and to its maker's own
	// limits, and it is suspended when the task is done or dropped.
	Task string `json:"task"`
}

// AsksFirst are the changes a new agent needs approval for unless told
// otherwise: those that cannot be taken back, and those that reach outside
// the workspace or change who can get in.
var AsksFirst = []string{
	"project.delete", "member.remove", "member.add", "workspace.update",
	"webhook.create", "webhook.update", "integration.create", "integration.update", "source.create", "source.update",
	"secret.set", "secret.delete",
}

// agentCreate makes an agent: a standing one, which an admin makes, or a
// helper for one task, which any member may.
func agentCreate(c *cx, a agentCreateArgs) error {
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
	forTask, err := c.agentTask(a, role)
	if err != nil {
		return err
	}
	rm, err := c.agentResponsible(a)
	if err != nil {
		return err
	}
	scope, err := c.newAgentScope(a, forTask)
	if err != nil {
		return err
	}
	u := core.User{ID: uid, Kind: core.KindAgent, Name: name, Description: a.Description, Avatar: a.Avatar, WorkspaceID: c.ws,
		ResponsibleID: rm.UserID, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	if err := c.tx.Insert(c.ctx, u); err != nil {
		return alreadyInUse(err, "id", uid)
	}
	return c.addMember(core.Member{WorkspaceID: c.ws, UserID: uid, Role: role, Handle: handle, Kind: u.Kind, Name: u.Name,
		Avatar: u.Avatar, Title: a.Description, Scope: scope, Budget: a.Budget, CreatedAt: c.at, ResponsibleID: rm.UserID,
		DelegatedBy: delegatedBy(c, forTask), DelegatedTask: forTask.ID})
}

// agentTask finds the task a sub-agent is made for, and says whether the
// actor may make this agent at all: a helper for a task, within the limit
// on helpers, or with the admin role a standing agent.
func (c *cx) agentTask(a agentCreateArgs, role core.Role) (core.Task, error) {
	var err error
	var forTask core.Task
	if a.Task != "" {
		if forTask, err = c.task("task", a.Task); err != nil {
			return forTask, err
		}
		if role != core.RoleMember {
			return forTask, invalid("role", "a sub-agent made for a task is a member")
		}
		// Help does not nest: a helper was made for one task and does not
		// hand it, or another, further down.
		if !c.system && c.actor.Kind == core.KindAgent {
			var me core.Member
			ok, err := found(c.tx.Get(c.ctx, &me, store.Eq("user_id", c.actor.UserID)))
			if err != nil {
				return forTask, err
			}
			if ok && me.DelegatedTask != "" {
				return forTask, forbidden("a helper made for a task cannot make helpers of its own; ask the agent that made you")
			}
		}
		if n, err := c.tx.Count(c.ctx, "members", store.Eq("delegated_task", forTask.ID), store.Null("suspended_at"), store.Null("removed_at")); err != nil {
			return forTask, err
		} else if n >= maxHelpers {
			return forTask, conflictErr("%s already has %d helpers at work; that is the most a task takes", forTask.Key, n)
		}
	} else if !c.system && !c.actor.Role.AtLeast(core.RoleAdmin) {
		if c.actor.Kind == core.KindAgent {
			var me core.Member
			ok, err := found(c.tx.Get(c.ctx, &me, store.Eq("user_id", c.actor.UserID)))
			if err != nil {
				return forTask, err
			}
			if ok && me.DelegatedTask != "" {
				return forTask, forbidden("a helper made for a task cannot make agents; ask the agent that made you")
			}
		}
		return forTask, forbidden("agent.create needs the admin role; you are a %s. To get help on one task, make a sub-agent for it: add \"task\": \"SVA-12\"", c.actor.Role)
	}
	return forTask, nil
}

// agentResponsible finds the person who answers for a new agent.
func (c *cx) agentResponsible(a agentCreateArgs) (core.Member, error) {
	var err error
	// Someone answers for every agent. By default that is the person who
	// creates it; an agent that creates another passes on its own.
	responsible := c.actor.UserID
	if a.Responsible != "" {
		if responsible, err = c.optMember("responsible", a.Responsible); err != nil {
			return core.Member{}, err
		}
	} else if c.actor.Kind == core.KindAgent {
		var self core.User
		if err := c.tx.Get(c.ctx, &self, store.Eq("id", c.actor.UserID)); err != nil {
			return core.Member{}, err
		}
		responsible = self.ResponsibleID
	}
	rm, err := c.memberRef("responsible", responsible)
	if err != nil {
		return rm, err
	}
	if rm.Kind != core.KindPerson {
		return rm, invalid("responsible", "the one responsible for an agent must be a person, not another agent")
	}
	return rm, nil
}

// newAgentScope is what a new agent may reach.
func (c *cx) newAgentScope(a agentCreateArgs, forTask core.Task) (*core.Scope, error) {
	scope, err := c.scopeArg(a.Scope, nil)
	if err != nil {
		return nil, err
	}
	// The person decides: unless its maker says otherwise (an explicit
	// needs_approval list, empty for none), a new agent asks before anything
	// that cannot be taken back or that reaches outside.
	if a.Scope == nil || a.Scope.NeedsApproval == nil {
		if scope == nil {
			scope = &core.Scope{}
		}
		scope.NeedsApproval = append([]string(nil), AsksFirst...)
	}
	scope = c.capScope(scope)
	if forTask.ID != "" {
		// Whatever was asked for, a sub-agent works in its task's project only.
		if scope == nil {
			scope = &core.Scope{}
		}
		scope.Projects = []string{forTask.ProjectID}
	}
	return scope, nil
}

// maxHelpers is how many sub-agents may be at work on one task at a time.
const maxHelpers = 3

func delegatedBy(c *cx, t core.Task) string {
	if t.ID == "" {
		return ""
	}
	return c.actor.UserID
}

// endDelegates suspends the sub-agents made for a task once it is done or
// dropped, and ends their tokens: they were made for that work only.
func (c *cx) endDelegates(t core.Task) error {
	var subs []core.Member
	if err := c.tx.List(c.ctx, &subs, store.Where(store.Eq("delegated_task", t.ID), store.Null("suspended_at"), store.Null("removed_at"))); err != nil {
		return err
	}
	for _, m := range subs {
		seq := c.tx.NextSeq()
		if _, err := c.tx.Update(c.ctx, "members", map[string]any{"suspended_at": c.at, "updated_seq": seq}, store.Eq("user_id", m.UserID)); err != nil {
			return err
		}
		if _, err := c.tx.Update(c.ctx, "api_tokens", map[string]any{"revoked_at": c.at}, store.Eq("user_id", m.UserID), store.Null("revoked_at")); err != nil {
			return err
		}
		if err := c.emit(seq, "member.updated", "member", m.UserID, "workspace", c.ws, "", map[string]any{"id": m.UserID, "user_id": m.UserID,
			"changes": map[string]core.FieldChange{"suspended_at": {To: c.at}}, "reason": "its task " + t.Key + " is closed"}); err != nil {
			return err
		}
	}
	return nil
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
		scope.Projects = intersectProjects(mine.Projects, orAll(scope.Projects, mine.Projects))
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

func agentUpdate(c *cx, a agentUpdateArgs) error {
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
		p.setText("title", a.Description, &m.Title)
		userSet["description"] = m.Title
	}
	if a.Avatar.Set {
		p.setText("avatar", a.Avatar, &m.Avatar)
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
			if sc, err = c.scopeArg(&a.Scope.V, m.Scope); err != nil {
				return err
			}
		}
		sc = c.capScope(sc)
		p.set["scope"] = sc
		p.changes["scope"] = core.FieldChange{From: m.Scope, To: sc}
	}
	if a.Budget.Set {
		var b *core.Budget
		if !a.Budget.Null && (a.Budget.V.CostMicros > 0 || a.Budget.V.Minutes > 0 || a.Budget.V.Handoffs > 0) {
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
