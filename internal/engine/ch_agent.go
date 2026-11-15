package engine

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("session.start", core.RoleMember, sessionStart)
	register("session.update", core.RoleMember, sessionUpdate)
	register("resource.create", core.RoleAdmin, resourceCreate)
	register("resource.delete", core.RoleAdmin, resourceDelete)
	register("resource.acquire", core.RoleMember, resourceAcquire)
	register("resource.release", core.RoleMember, resourceRelease)
	register("webhook.create", core.RoleAdmin, webhookCreate)
	register("webhook.update", core.RoleAdmin, webhookUpdate)
	register("webhook.delete", core.RoleAdmin, webhookDelete)
	register("rule.create", core.RoleAdmin, ruleCreate)
	register("rule.update", core.RoleAdmin, ruleUpdate)
	register("rule.delete", core.RoleAdmin, ruleDelete)
	register("integration.create", core.RoleAdmin, integrationCreate)
	register("integration.update", core.RoleAdmin, integrationUpdate)
	register("integration.delete", core.RoleAdmin, integrationDelete)
	register("notification.read", core.RoleMember, notificationRead)
	register("notify", core.RoleMember, notifyMember)
}

// ---- session records and budgets ----

// Usage sums what an agent's recorded sessions cost since a time.
func (e *Engine) Usage(ctx context.Context, db store.DB, agentID string, since int64) (costMicros, minutes int64, err error) {
	var ss []core.AgentSession
	if err := db.List(ctx, &ss, store.Where(store.Eq("agent_id", agentID), store.Gte("started_at", since))); err != nil {
		return 0, 0, err
	}
	now := e.now().UnixMilli()
	for _, s := range ss {
		costMicros += s.CostMicros
		end := s.EndedAt
		if end == 0 {
			end = now
		}
		minutes += (end - s.StartedAt) / 60_000
	}
	return costMicros, minutes, nil
}

type sessionStartArgs struct {
	ID           string `json:"id"`
	Task         string `json:"task"`
	Title        string `json:"title"`
	Instructions string `json:"instructions"` // what the run was asked to do
}

func sessionStart(c *cx) error {
	var a sessionStartArgs
	if err := c.args(&a); err != nil {
		return err
	}
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if err := c.checkBudget(); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	s := core.AgentSession{ID: sid, WorkspaceID: c.ws, AgentID: c.actor.UserID, Title: a.Title, Instructions: a.Instructions,
		State: "running", StartedAt: c.at, UpdatedSeq: seq}
	scopeType, scopeID, projectID, key := "workspace", c.ws, "", ""
	if a.Task != "" {
		t, err := c.task("task", a.Task)
		if err != nil {
			return err
		}
		s.TaskID, scopeType, scopeID, projectID, key = t.ID, "task", t.ID, t.ProjectID, t.Key
		if s.Title == "" {
			s.Title = t.Title
		}
		// A task can carry its own limit on what may be spent on it.
		if err := c.checkTaskBudget(t); err != nil {
			return err
		}
	}
	if err := c.tx.Insert(c.ctx, s); err != nil {
		return taken(err, "id", sid)
	}
	c.ref = s.ID
	return c.emit(seq, "session.created", "session", s.ID, scopeType, scopeID, projectID, map[string]any{"row": s, "key": key})
}

type sessionUpdateArgs struct {
	ID      string      `json:"id"`
	Title   Opt[string] `json:"title"`
	Summary Opt[string] `json:"summary"`
	// State: running, done, failed or stopped. Anything but running ends
	// the session.
	State Opt[string] `json:"state"`
	// AddSteps appends to what the run did, in order.
	AddSteps []json.RawMessage `json:"add_steps"`
	// AddLinks appends commits, files or URLs the run produced.
	AddLinks []json.RawMessage `json:"add_links"`
	// Totals so far, not increments.
	CostMicros Opt[int] `json:"cost_micros"`
	TokensIn   Opt[int] `json:"tokens_in"`
	TokensOut  Opt[int] `json:"tokens_out"`
}

func appendJSON(cur json.RawMessage, add []json.RawMessage) json.RawMessage {
	var list []json.RawMessage
	if len(cur) > 0 {
		_ = json.Unmarshal(cur, &list)
	}
	list = append(list, add...)
	out, _ := json.Marshal(list)
	return out
}

func sessionUpdate(c *cx) error {
	var a sessionUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	s, err := get[core.AgentSession](c, "session", "id", a.ID)
	if err != nil {
		return err
	}
	if s.AgentID != c.actor.UserID && !c.system {
		return forbidden("a session is updated by the agent that started it")
	}
	p := newPatch()
	p.str("title", a.Title, &s.Title)
	p.str("summary", a.Summary, &s.Summary)
	if a.State.Set {
		states := []string{"running", "done", "failed", "stopped"}
		if !contains(states, a.State.V) {
			return oneOf("state", "session state", a.State.V, states)
		}
		p.str("state", a.State, &s.State)
		if s.State != "running" && s.EndedAt == 0 {
			p.put("ended_at", int64(0), c.at)
		}
	}
	// The event carries the whole new list, so a reader's copy stays right
	// without asking again.
	if len(a.AddSteps) > 0 {
		all := appendJSON(s.Steps, a.AddSteps)
		p.set["steps"] = all
		p.changes["steps"] = core.FieldChange{To: all}
	}
	if len(a.AddLinks) > 0 {
		all := appendJSON(s.Links, a.AddLinks)
		p.set["links"] = all
		p.changes["links"] = core.FieldChange{To: all}
	}
	before := s.CostMicros
	total := func(col string, o Opt[int], cur *int64) {
		if o.Set && int64(o.V) != *cur {
			p.put(col, *cur, int64(o.V))
			*cur = int64(o.V)
		}
	}
	total("cost_micros", a.CostMicros, &s.CostMicros)
	total("tokens_in", a.TokensIn, &s.TokensIn)
	total("tokens_out", a.TokensOut, &s.TokensOut)
	scopeType, scopeID, projectID := "workspace", c.ws, ""
	if s.TaskID != "" {
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", s.TaskID)); err == nil {
			scopeType, scopeID, projectID = "task", t.ID, t.ProjectID
		}
	}
	if err := c.save(p, "agent_sessions", "session", s.ID, scopeType, scopeID, projectID, nil); err != nil {
		return err
	}
	_ = before
	return c.budgetWarnings(s)
}

// taskSpend adds up what agents have spent on a task: cost, and minutes of
// work, the running sessions included.
func (c *cx) taskSpend(taskID string) (cost, minutes int64, err error) {
	var spent []core.AgentSession
	if err := c.tx.List(c.ctx, &spent, store.Where(store.Eq("task_id", taskID))); err != nil {
		return 0, 0, err
	}
	for _, sp := range spent {
		cost += sp.CostMicros
		end := sp.EndedAt
		if end == 0 {
			end = c.at
		}
		minutes += (end - sp.StartedAt) / 60_000
	}
	return cost, minutes, nil
}

// checkTaskBudget refuses new work on a task whose own budget is used up.
// Saying so on the task, and handing it back, stay possible: a clean stop.
func (c *cx) checkTaskBudget(t core.Task) error {
	b := t.Budget
	if b == nil || c.system || c.actor.Kind != core.KindAgent {
		return nil
	}
	cost, minutes, err := c.taskSpend(t.ID)
	if err != nil {
		return err
	}
	if b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes {
		return &Error{Code: CodeBudget, Message: "the budget set for " + t.Key + " is used up; say so on the task and ask for more before going on"}
	}
	return nil
}

// budgetWarnings tells the people concerned, once, when an agent's week or
// a task's own budget is four-fifths used: in cost or in time.
func (c *cx) budgetWarnings(s core.AgentSession) error {
	near := func(used, limit int64) bool { return limit > 0 && used*10 >= limit*8 }
	once := func(userID, entityType, entityID, title string, since int64) error {
		if userID == "" {
			return nil
		}
		n, err := c.tx.Count(c.ctx, "notifications", store.Eq("user_id", userID), store.Eq("type", core.NoteBudget),
			store.Eq("entity_id", entityID), store.Eq("title", title), store.Gte("created_at", since))
		if err != nil || n > 0 {
			return err
		}
		return c.notify(userID, core.NoteBudget, core.Notification{EntityType: entityType, EntityID: entityID, Title: title, TaskID: s.TaskID})
	}
	var self core.User
	if err := c.tx.Get(c.ctx, &self, store.Eq("id", s.AgentID)); err != nil {
		return nil
	}
	if b := c.actor.Budget; b != nil && c.actor.UserID == s.AgentID {
		cost, minutes, err := c.e.Usage(c.ctx, c.tx, s.AgentID, weekStart(c.at))
		if err != nil {
			return err
		}
		if near(cost, b.CostMicros) || near(minutes, b.Minutes) {
			title := c.actor.Name + " has used 80% of its weekly budget"
			if b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes {
				title = c.actor.Name + " has used up its weekly budget"
			}
			if err := once(self.ResponsibleID, "member", s.AgentID, title, weekStart(c.at)); err != nil {
				return err
			}
		}
	}
	if s.TaskID == "" {
		return nil
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", s.TaskID)); err != nil || t.Budget == nil {
		return nil
	}
	cost, minutes, err := c.taskSpend(t.ID)
	if err != nil {
		return err
	}
	if near(cost, t.Budget.CostMicros) || near(minutes, t.Budget.Minutes) {
		who := t.AskedBy
		if who == "" {
			who = self.ResponsibleID
		}
		title := t.Key + " has used 80% of its budget"
		if cost >= t.Budget.CostMicros && t.Budget.CostMicros > 0 || minutes >= t.Budget.Minutes && t.Budget.Minutes > 0 {
			title = t.Key + " has used up its budget"
		}
		return once(who, "task", t.ID, title, 0)
	}
	return nil
}

// ---- shared resources ----

type resourceCreateArgs struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func resourceCreate(c *cx) error {
	var a resourceCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
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

func resourceDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
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
	return c.emit(c.tx.NextSeq(), "claim.updated", "claim", cl.ID, "workspace", c.ws, c.claimProject(cl), map[string]any{"id": cl.ID, "changes": changes, "why": why})
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
func resourceAcquire(c *cx) error {
	var a resourceAcquireArgs
	if err := c.args(&a); err != nil {
		return err
	}
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

func resourceRelease(c *cx) error {
	var a resourceReleaseArgs
	if err := c.args(&a); err != nil {
		return err
	}
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

// ---- webhooks ----

type webhookCreateArgs struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	URL        string   `json:"url"`
	Secret     string   `json:"secret"`      // signs each delivery; made by the caller so it can be shown once
	EventTypes []string `json:"event_types"` // empty = every event
	Project    string   `json:"project"`
	// For, when set, sends only what lands in this member's inbox: the
	// push way to wake an agent.
	For    string `json:"for"`
	Active *bool  `json:"active"`
}

func checkURL(field, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return invalid(field, "%q is not an http or https URL", raw)
	}
	return nil
}

func webhookCreate(c *cx) error {
	var a webhookCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	wid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if err := checkURL("url", a.URL); err != nil {
		return err
	}
	w := core.Webhook{ID: wid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), URL: a.URL, Secret: a.Secret, EventTypes: a.EventTypes,
		Active: a.Active == nil || *a.Active, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if w.Name == "" {
		u, _ := url.Parse(a.URL)
		w.Name = u.Host
	}
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		w.ProjectID = p.ID
	}
	if w.UserID, err = c.optMember("for", a.For); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	w.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, w); err != nil {
		return taken(err, "id", wid)
	}
	return c.created(seq, "webhook", w.ID, "workspace", c.ws, "", w)
}

type webhookUpdateArgs struct {
	ID         string        `json:"id"`
	Name       Opt[string]   `json:"name"`
	URL        Opt[string]   `json:"url"`
	Secret     Opt[string]   `json:"secret"`
	EventTypes Opt[[]string] `json:"event_types"`
	Project    Opt[string]   `json:"project"`
	For        Opt[string]   `json:"for"`
	Active     Opt[bool]     `json:"active"`
}

func webhookUpdate(c *cx) error {
	var a webhookUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	w, err := get[core.Webhook](c, "webhook", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &w.Name); err != nil {
		return err
	}
	if a.URL.Set {
		if err := checkURL("url", a.URL.V); err != nil {
			return err
		}
		p.str("url", a.URL, &w.URL)
	}
	if a.Secret.Set && a.Secret.V != w.Secret {
		p.set["secret"] = a.Secret.V
		p.changes["secret"] = core.FieldChange{To: "(changed)"}
	}
	if a.EventTypes.Set {
		p.put("event_types", w.EventTypes, a.EventTypes.V)
	}
	if a.Project.Set {
		pid := ""
		if !a.Project.Null && a.Project.V != "" {
			pr, err := c.project(a.Project.V)
			if err != nil {
				return err
			}
			pid = pr.ID
		}
		p.put("project_id", w.ProjectID, pid)
	}
	if a.For.Set {
		uid := ""
		if !a.For.Null {
			if uid, err = c.optMember("for", a.For.V); err != nil {
				return err
			}
		}
		p.put("user_id", w.UserID, uid)
	}
	if a.Active.Set && a.Active.V != w.Active {
		p.put("active", w.Active, a.Active.V)
		if a.Active.V {
			p.set["failures"] = 0 // turning it back on gives it a clean slate
		}
	}
	return c.save(p, "webhooks", "webhook", w.ID, "workspace", c.ws, "", nil)
}

func webhookDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	w, err := get[core.Webhook](c, "webhook", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash("webhooks", "webhook", w.ID, "workspace", c.ws, "", nil)
}

// ---- rules ----

type ruleArgs struct {
	ID     string           `json:"id"`
	Name   string           `json:"name"`
	Active *bool            `json:"active"`
	Match  *core.RuleMatch  `json:"match"`
	Action *core.RuleAction `json:"action"`
}

var ruleActions = []string{"notify", "webhook", "assign", "wait_on"}

// checkRule resolves the names in a rule to ids and refuses what cannot run.
func (c *cx) checkRule(m *core.RuleMatch, a *core.RuleAction) error {
	if a == nil || !contains(ruleActions, a.Kind) {
		kind := ""
		if a != nil {
			kind = a.Kind
		}
		return oneOf("action.kind", "action", kind, ruleActions)
	}
	if m != nil {
		if m.ProjectID != "" {
			p, err := c.project(m.ProjectID)
			if err != nil {
				return err
			}
			m.ProjectID = p.ID
		}
		if m.ActorID != "" {
			mem, err := c.memberRef("match.actor_id", m.ActorID)
			if err != nil {
				return err
			}
			m.ActorID = mem.UserID
		}
		if m.ActorKind != "" && m.ActorKind != core.KindPerson && m.ActorKind != core.KindAgent {
			return oneOf("match.actor_kind", "kind", m.ActorKind, []string{core.KindPerson, core.KindAgent})
		}
		if m.ToCategory != "" && !core.ValidCategory(m.ToCategory) {
			return oneOf("match.to_category", "category", m.ToCategory, core.Categories)
		}
	}
	if a.Kind == "webhook" {
		if _, err := get[core.Webhook](c, "webhook", "action.webhook_id", a.WebhookID); err != nil {
			return err
		}
		return nil
	}
	mem, err := c.memberRef("action.user_id", a.UserID)
	if err != nil {
		return err
	}
	a.UserID = mem.UserID
	return nil
}

func ruleCreate(c *cx) error {
	var a ruleArgs
	if err := c.args(&a); err != nil {
		return err
	}
	rid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a rule needs a name")
	}
	if a.Match == nil {
		a.Match = &core.RuleMatch{}
	}
	if err := c.checkRule(a.Match, a.Action); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	r := core.Rule{ID: rid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Active: a.Active == nil || *a.Active, Match: a.Match,
		Action: a.Action, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, r); err != nil {
		return taken(err, "id", rid)
	}
	return c.created(seq, "rule", r.ID, "workspace", c.ws, "", r)
}

func ruleUpdate(c *cx) error {
	var a ruleArgs
	if err := c.args(&a); err != nil {
		return err
	}
	r, err := get[core.Rule](c, "rule", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if a.Name != "" {
		p.put("name", r.Name, strings.TrimSpace(a.Name))
	}
	if a.Active != nil {
		p.put("active", r.Active, *a.Active)
	}
	if a.Match != nil || a.Action != nil {
		m, act := r.Match, r.Action
		if a.Match != nil {
			m = a.Match
		}
		if a.Action != nil {
			act = a.Action
		}
		if err := c.checkRule(m, act); err != nil {
			return err
		}
		p.set["match_on"], p.set["action"] = m, act
		p.changes["match"], p.changes["action"] = core.FieldChange{To: m}, core.FieldChange{To: act}
	}
	return c.save(p, "rules", "rule", r.ID, "workspace", c.ws, "", nil)
}

func ruleDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	r, err := get[core.Rule](c, "rule", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash("rules", "rule", r.ID, "workspace", c.ws, "", nil)
}

// ---- integrations ----

type integrationArgs struct {
	ID      string               `json:"id"`
	Kind    string               `json:"kind"` // github
	Name    Opt[string]          `json:"name"`
	Project Opt[string]          `json:"project"`
	Config  Opt[json.RawMessage] `json:"config"`
	// Secret is the service's token. It is stored encrypted, used by the
	// server, and never returned.
	Secret Opt[string] `json:"secret"`
	Active Opt[bool]   `json:"active"`
}

// Seal encrypts a secret before it is stored. The server sets it.
var Seal = func(plain string) (string, error) { return plain, nil }

var integrationKinds = []string{"github"}

func integrationCreate(c *cx) error {
	var a integrationArgs
	if err := c.args(&a); err != nil {
		return err
	}
	iid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if !contains(integrationKinds, a.Kind) {
		return oneOf("kind", "integration", a.Kind, integrationKinds)
	}
	in := core.Integration{ID: iid, WorkspaceID: c.ws, Kind: a.Kind, Name: a.Name.V, Config: a.Config.V, Active: !a.Active.Set || a.Active.V,
		CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if a.Project.V != "" {
		p, err := c.project(a.Project.V)
		if err != nil {
			return err
		}
		in.ProjectID = p.ID
	}
	if a.Secret.V != "" {
		if in.Secret, err = Seal(a.Secret.V); err != nil {
			return err
		}
		in.HasSecret = true
	}
	seq := c.tx.NextSeq()
	in.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, in); err != nil {
		return taken(err, "id", iid)
	}
	return c.created(seq, "integration", in.ID, "workspace", c.ws, "", in)
}

func integrationUpdate(c *cx) error {
	var a integrationArgs
	if err := c.args(&a); err != nil {
		return err
	}
	in, err := get[core.Integration](c, "integration", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.str("name", a.Name, &in.Name)
	if a.Project.Set {
		pid := ""
		if a.Project.V != "" {
			pr, err := c.project(a.Project.V)
			if err != nil {
				return err
			}
			pid = pr.ID
		}
		p.put("project_id", in.ProjectID, pid)
	}
	if a.Config.Set && string(a.Config.V) != string(in.Config) {
		p.set["config"] = a.Config.V
		p.changes["config"] = core.FieldChange{From: in.Config, To: a.Config.V}
	}
	if a.Secret.Set {
		sealed := ""
		if a.Secret.V != "" {
			if sealed, err = Seal(a.Secret.V); err != nil {
				return err
			}
		}
		p.set["secret"] = sealed
		p.changes["has_secret"] = core.FieldChange{To: sealed != ""}
	}
	p.flag("active", a.Active, &in.Active)
	return c.save(p, "integrations", "integration", in.ID, "workspace", c.ws, "", nil)
}

func integrationDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	in, err := get[core.Integration](c, "integration", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash("integrations", "integration", in.ID, "workspace", c.ws, "", nil)
}

// ---- inbox ----

type notificationReadArgs struct {
	IDs []string `json:"ids"`
	// Task marks everything about one task. All marks the whole inbox.
	Task string `json:"task"`
	All  bool   `json:"all"`
	// UpTo limits "all" to items at or before this feed position, so items
	// that arrived while the caller was reading stay unread.
	UpTo int64 `json:"up_to"`
	// Unread puts the items back as unread. Archive takes them out of the inbox.
	Unread  bool `json:"unread"`
	Archive bool `json:"archive"`
}

// notificationRead marks the caller's inbox items as handled.
func notificationRead(c *cx) error {
	var a notificationReadArgs
	if err := c.args(&a); err != nil {
		return err
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
	case a.Unread:
		conds = append(conds, store.NotNull("read_at"))
		set = map[string]any{"read_at": int64(0)}
	default:
		conds = append(conds, store.Null("read_at"))
		set = map[string]any{"read_at": c.at}
	}
	var rows []core.Notification
	if err := c.tx.List(c.ctx, &rows, store.Q{Where: conds, Limit: 5000}); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	if _, err := c.tx.Update(c.ctx, "notifications", set, store.In("id", ids)); err != nil {
		return err
	}
	changes := map[string]core.FieldChange{}
	for k, v := range set {
		changes[k] = core.FieldChange{To: v}
	}
	return c.emitTo(c.actor.UserID, c.tx.NextSeq(), "notification.updated", "notification", ids[0], "workspace", c.ws, "",
		map[string]any{"ids": ids, "changes": changes})
}

type notifyArgs struct {
	User    string `json:"user"`
	Task    string `json:"task"`
	Message string `json:"message"`
}

// notifyMember puts a plain message in a member's inbox. Rules use it.
func notifyMember(c *cx) error {
	var a notifyArgs
	if err := c.args(&a); err != nil {
		return err
	}
	m, err := c.memberRef("user", a.User)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Message) == "" {
		return invalid("message", "say what the member should know")
	}
	n := core.Notification{EntityType: "member", EntityID: m.UserID, Title: a.Message}
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
