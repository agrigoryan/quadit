// Package engine applies changes. Every write to a workspace, from a person
// in the browser or an agent on the API, is a named change with an id made by
// the caller. The engine checks it, writes the rows and the events in one
// transaction, and remembers the id so the same change sent twice is applied
// once.
package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Change is one named write.
type Change struct {
	ID   string          `json:"id"`   // made by the caller; reusing it makes the change safe to resend
	Type string          `json:"type"` // for example "task.update"
	Args json.RawMessage `json:"args"`
	// Approval is the id of an approved decision, for a change the actor
	// may only make with approval.
	Approval string `json:"approval,omitempty"`
	// For names the member an agent is doing this for (@handle or id). The
	// change is then allowed only if that member could make it too, so a
	// shared agent with wide access cannot be used to get around someone's
	// own narrower access.
	For string `json:"for,omitempty"`
}

// Result says what a change produced.
type Result struct {
	ChangeID string `json:"change_id"`
	Type     string `json:"type"`
	// Seq is the feed position that includes this change. A reader that has
	// reached Seq has seen everything the change did.
	Seq      int64 `json:"seq"`
	FirstSeq int64 `json:"first_seq"`
	// Duplicate is true when this id was already applied; nothing was
	// written this time.
	Duplicate bool `json:"duplicate,omitempty"`
	// Ref is the id of the main thing the change made or touched, and Key
	// its short name when it has one (SVA-12).
	Ref    string       `json:"ref,omitempty"`
	Key    string       `json:"key,omitempty"`
	Events []core.Event `json:"events,omitempty"`
}

// Error codes. Every refusal has one, so a caller can branch without reading
// the message.
const (
	CodeInvalid       = "invalid"        // the change itself is wrong; fix it and resend
	CodeForbidden     = "forbidden"      // the actor may not do this
	CodeNotFound      = "not_found"      // something the change refers to does not exist
	CodeConflict      = "conflict"       // it collides with what is there (a taken key, an answered decision)
	CodeStale         = "stale"          // it was based on an older version than the current one
	CodeNeedsApproval = "needs_approval" // allowed only with an approved decision
	CodeBudget        = "budget_exceeded"
)

// Error is a refusal that tells the caller how to fix the change.
type Error struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Field   string   `json:"field,omitempty"`
	Allowed []string `json:"allowed,omitempty"` // the values that would have been accepted
	Nearest string   `json:"nearest,omitempty"` // the allowed value closest to what was sent
	// Index is the position of the refused change in a batch.
	Index int `json:"index,omitempty"`
}

func (e *Error) Error() string {
	msg := e.Code + ": " + e.Message
	if e.Nearest != "" {
		msg += " (did you mean " + e.Nearest + "?)"
	} else if len(e.Allowed) > 0 {
		msg += " (allowed: " + strings.Join(e.Allowed, ", ") + ")"
	}
	return msg
}

func invalid(field, format string, a ...any) *Error {
	return &Error{Code: CodeInvalid, Field: field, Message: fmt.Sprintf(format, a...)}
}

func forbidden(format string, a ...any) *Error {
	return &Error{Code: CodeForbidden, Message: fmt.Sprintf(format, a...)}
}

func conflictErr(format string, a ...any) *Error {
	return &Error{Code: CodeConflict, Message: fmt.Sprintf(format, a...)}
}

func notFound(what, ref string) *Error {
	return &Error{Code: CodeNotFound, Message: fmt.Sprintf("%s %q does not exist in this workspace", what, ref)}
}

// oneOf refuses a value that is not in a fixed set, naming the set and the
// nearest match.
func oneOf(field, what, got string, allowed []string) *Error {
	return &Error{Code: CodeInvalid, Field: field, Message: fmt.Sprintf("unknown %s %q", what, got),
		Allowed: allowed, Nearest: nearest(got, allowed)}
}

// missing turns a store "not found" into a refusal naming what was missing.
func missing(err error, what, ref string) error {
	if errors.Is(err, store.ErrNotFound) {
		return notFound(what, ref)
	}
	return err
}

func taken(err error, what, value string) error {
	if errors.Is(err, store.ErrConflict) {
		return conflictErr("%s %q is already in use", what, value)
	}
	return err
}

// Actor is who sends a change, and how the credential they used narrows
// what their role allows.
type Actor struct {
	UserID   string
	ReadOnly bool
	Projects []string // project ids the credential is limited to; nil = no limit
}

// Engine applies changes to one store.
type Engine struct {
	st  store.Store
	now func() time.Time
	// OnCommit, when set, is called after a write commits with the
	// workspace and its new position in the feed.
	OnCommit func(workspaceID string, seq int64)
}

// New returns an engine over st.
func New(st store.Store) *Engine {
	return &Engine{st: st, now: time.Now}
}

// Store returns the store, for reads.
func (e *Engine) Store() store.Store { return e.st }

// Now returns the engine's clock in Unix milliseconds.
func (e *Engine) Now() int64 { return e.now().UnixMilli() }

// handler is one kind of change.
type handler struct {
	min core.Role // the least role that may send it
	fn  func(*cx) error
	doc string
}

var handlers = map[string]handler{}

func register(name string, min core.Role, fn func(*cx) error) {
	handlers[name] = handler{min: min, fn: fn}
}

// ChangeTypes lists the changes the engine accepts.
func ChangeTypes() []string {
	out := make([]string, 0, len(handlers))
	for k := range handlers {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// MinRole returns the least role that may send a change type.
func MinRole(changeType string) (core.Role, bool) {
	h, ok := handlers[changeType]
	return h.min, ok
}

// cx is what a handler works with: one change, one actor, one transaction.
type cx struct {
	*Resolver // ctx, actor, at, and finding things by name
	e         *Engine
	tx        store.Tx
	ws        string
	scope     core.Scope
	change    Change
	events    []core.Event
	ref, key  string
	subRef    string // the ref of the last change run with sub
	notified  map[string]bool
	// system is set while the engine itself acts (rules, roll-overs): role
	// and scope checks are skipped.
	system bool
	// selfNotify lets a notification reach the actor, for rules.
	selfNotify bool
	// origin, when set, is stamped on every event the write emits, so the
	// rule that caused a change is known and rules do not set each other off.
	origin string
	// asker is the member named with "for": the one this change is made for.
	asker string
	// askerOK remembers the tasks whose asker was already checked.
	askerOK map[string]bool
}

// args decodes the change's arguments into v. Unknown fields are refused, so
// a misspelt field is an error and not a silent no-op.
func (c *cx) args(v any) error {
	raw := c.change.Args
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		msg := err.Error()
		if strings.HasPrefix(msg, "json: unknown field ") {
			name := strings.Trim(strings.TrimPrefix(msg, "json: unknown field "), `"`)
			allowed := jsonFields(v)
			return &Error{Code: CodeInvalid, Field: name, Message: fmt.Sprintf("%s has no field %q", c.change.Type, name),
				Allowed: allowed, Nearest: nearest(name, allowed)}
		}
		return invalid("args", "%s: %v", c.change.Type, err)
	}
	return nil
}

// emit records an event under a sequence number from this transaction.
func (c *cx) emit(seq int64, typ, entityType, entityID, scopeType, scopeID, projectID string, data any) error {
	return c.emitTo("", seq, typ, entityType, entityID, scopeType, scopeID, projectID, data)
}

// emitTo records an event only one member may see.
func (c *cx) emitTo(audience string, seq int64, typ, entityType, entityID, scopeType, scopeID, projectID string, data any) error {
	if projectID != "" && !c.system && len(c.scope.Projects) > 0 && !contains(c.scope.Projects, projectID) {
		return forbidden("your access does not include this project")
	}
	if scopeType == "task" {
		if err := c.checkAsker(scopeID); err != nil {
			return err
		}
	}
	if m, ok := data.(map[string]any); ok && c.origin != "" {
		m["rule"] = c.origin
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	ev := core.Event{
		WorkspaceID: c.ws, Seq: seq, At: c.at, ActorID: c.actor.UserID, ChangeID: c.change.ID,
		Type: typ, EntityType: entityType, EntityID: entityID, ScopeType: scopeType, ScopeID: scopeID,
		ProjectID: projectID, AudienceID: audience, Data: raw,
	}
	if err := c.tx.Emit(c.ctx, ev); err != nil {
		return err
	}
	c.events = append(c.events, ev)
	return nil
}

// created emits "<entity>.created" carrying the whole new row.
func (c *cx) created(seq int64, entity, entityID, scopeType, scopeID, projectID string, row any) error {
	c.ref = entityID
	return c.emit(seq, entity+".created", entity, entityID, scopeType, scopeID, projectID, map[string]any{"row": row})
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// newID returns given if the caller made an id, else a fresh one.
func newID(field, given string) (string, error) {
	if given == "" {
		return id.New(), nil
	}
	if !id.Valid(given) {
		return "", invalid(field, "%q is not a valid id: use a lower-case UUID, or leave it out", given)
	}
	return given, nil
}

// Apply runs one change.
func (e *Engine) Apply(ctx context.Context, workspaceID string, actor Actor, ch Change) (*Result, error) {
	res, err := e.Batch(ctx, workspaceID, actor, []Change{ch}, false)
	if err != nil {
		return nil, err
	}
	return res[0], nil
}

var errDryRun = errors.New("dry run")

// Batch runs several changes in one transaction: all apply or none do. With
// dryRun the changes are checked and their events returned, and nothing is
// kept.
func (e *Engine) Batch(ctx context.Context, workspaceID string, actor Actor, changes []Change, dryRun bool) ([]*Result, error) {
	if len(changes) == 0 {
		return nil, invalid("changes", "send at least one change")
	}
	if len(changes) > 500 {
		return nil, invalid("changes", "a batch holds at most 500 changes; this one has %d", len(changes))
	}
	for i, ch := range changes {
		if !id.Valid(ch.ID) {
			return nil, at(i, invalid("id", "a change needs an id made by the caller (a lower-case UUID); resending the same id is then safe"))
		}
		if _, ok := handlers[ch.Type]; !ok {
			return nil, at(i, oneOf("type", "change type", ch.Type, ChangeTypes()))
		}
	}
	results := make([]*Result, len(changes))
	var lastSeq int64
	err := e.st.Write(ctx, workspaceID, func(raw store.Tx) error {
		var tx store.Tx = newMemoTx(raw)
		var m core.Member
		err := tx.Get(ctx, &m, store.Eq("user_id", actor.UserID), store.Null("removed_at"))
		if errors.Is(err, store.ErrNotFound) {
			return forbidden("you are not a member of this workspace")
		}
		if err != nil {
			return err
		}
		if m.SuspendedAt != 0 {
			return forbidden("your membership is suspended")
		}
		scope := core.Scope{}
		if m.Scope != nil {
			scope = *m.Scope
		}
		if actor.ReadOnly {
			scope.ReadOnly = true
		}
		if len(actor.Projects) > 0 {
			scope.Projects = narrow(scope.Projects, actor.Projects)
		}
		now := e.now().UnixMilli()
		for i, ch := range changes {
			res, err := e.applyOne(ctx, tx, m, scope, now, ch, dryRun)
			if err != nil {
				var ee *Error
				if errors.As(err, &ee) {
					return at(i, ee)
				}
				if errors.Is(err, store.ErrNotFound) {
					return at(i, &Error{Code: CodeNotFound, Message: err.Error()})
				}
				return fmt.Errorf("change %d (%s): %w", i, ch.Type, err)
			}
			results[i] = res
		}
		lastSeq = tx.Seq()
		if dryRun {
			return errDryRun
		}
		return nil
	})
	if err != nil && !errors.Is(err, errDryRun) {
		return nil, err
	}
	if err == nil && e.OnCommit != nil {
		e.OnCommit(workspaceID, lastSeq)
	}
	return results, nil
}

// narrow returns the project ids allowed by both lists; an empty list
// allows everything.
func narrow(a, b []string) []string {
	if len(a) == 0 {
		return b
	}
	var out []string
	for _, x := range b {
		if contains(a, x) {
			out = append(out, x)
		}
	}
	if len(out) == 0 {
		out = []string{"none"} // both lists exist but share nothing
	}
	return out
}

func at(i int, e *Error) *Error {
	cp := *e
	cp.Index = i
	return &cp
}

func (e *Engine) applyOne(ctx context.Context, tx store.Tx, m core.Member, scope core.Scope, now int64, ch Change, dryRun bool) (*Result, error) {
	h := handlers[ch.Type]
	hash := argsHash(ch)
	res := &Result{ChangeID: ch.ID, Type: ch.Type}

	var prev core.AppliedChange
	err := tx.Get(ctx, &prev, store.Eq("id", ch.ID))
	if err == nil {
		if prev.Type != ch.Type || prev.ArgsHash != hash || prev.ActorID != m.UserID {
			return nil, conflictErr("change id %s was already used for a different change; use a new id", ch.ID)
		}
		res.Duplicate, res.FirstSeq, res.Seq = true, prev.FirstSeq, prev.LastSeq
		return res, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if !m.Role.AtLeast(h.min) {
		return nil, forbidden("%s needs the %s role; you are a %s", ch.Type, h.min, m.Role)
	}
	askerID := ""
	if ch.For != "" {
		asker, err := (&Resolver{ctx: ctx, db: tx, actor: m, at: now}).memberRef("for", ch.For)
		if err != nil {
			return nil, err
		}
		askerID = asker.UserID
		if asker.SuspendedAt != 0 || !asker.Role.AtLeast(h.min) {
			return nil, forbidden("%s needs the %s role; @%s, who asked for it, is a %s", ch.Type, h.min, asker.Handle, asker.Role)
		}
		if asker.Scope != nil {
			if asker.Scope.ReadOnly {
				return nil, forbidden("@%s, who asked for this, may only read", asker.Handle)
			}
			if len(asker.Scope.Projects) > 0 {
				scope.Projects = narrow(scope.Projects, asker.Scope.Projects)
			}
		}
	}
	if scope.ReadOnly {
		return nil, forbidden("this credential is read-only")
	}
	c := &cx{Resolver: &Resolver{ctx: ctx, db: tx, actor: m, at: now}, e: e, tx: tx, ws: tx.WorkspaceID(), scope: scope,
		change: ch, notified: map[string]bool{}, asker: askerID, askerOK: map[string]bool{}}
	if contains(scope.NeedsApproval, ch.Type) {
		if err := c.checkApproval(); err != nil {
			return nil, err
		}
	}
	if err := h.fn(c); err != nil {
		return nil, err
	}
	res.Events, res.Ref, res.Key = c.events, c.ref, c.key
	applied := core.AppliedChange{WorkspaceID: c.ws, ID: ch.ID, ActorID: m.UserID, Type: ch.Type, ArgsHash: hash, CreatedAt: now}
	if len(c.events) > 0 {
		applied.FirstSeq = c.events[0].Seq
		applied.LastSeq = c.events[len(c.events)-1].Seq
	} else {
		// Nothing changed (an update to the values already there). The
		// change is still remembered, at the position it was checked.
		applied.FirstSeq, applied.LastSeq = tx.Seq(), tx.Seq()
	}
	res.FirstSeq, res.Seq = applied.FirstSeq, applied.LastSeq
	return res, tx.Insert(ctx, applied)
}

// checkApproval makes sure the change comes with an approved decision that
// was opened for this kind of change by this actor.
func (c *cx) checkApproval() error {
	need := &Error{Code: CodeNeedsApproval, Message: fmt.Sprintf(
		`%s needs approval. Open one with decision.open {"kind": "approval", "action": %q, "task": …, "question": …, "ask": …}, `+
			`wait for the answer, then resend this change with "approval": "<decision id>"`, c.change.Type, c.change.Type)}
	if c.change.Approval == "" {
		return need
	}
	var d core.Decision
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", c.change.Approval), store.Live); err != nil {
		return need
	}
	switch {
	case d.Kind != core.DecisionApproval || d.Action != c.change.Type:
		need.Message = fmt.Sprintf("decision %s is not an approval for %s", d.ID, c.change.Type)
	case d.CreatedBy != c.actor.UserID:
		need.Message = "that approval was asked for by someone else"
	case d.State == core.StateOpen:
		need.Message = "that approval has not been answered yet"
	case d.Outcome != core.OutcomeApproved:
		need.Code, need.Message = CodeForbidden, "that approval was declined"
	default:
		return nil
	}
	return need
}

func argsHash(ch Change) string {
	// Compact first, so the same arguments with different spacing hash alike.
	var buf bytes.Buffer
	if err := json.Compact(&buf, ch.Args); err != nil {
		buf.Reset()
		buf.Write(ch.Args)
	}
	sum := sha256.Sum256(append([]byte(ch.Type+"\n"+ch.For+"\n"), buf.Bytes()...))
	return hex.EncodeToString(sum[:])
}

// System runs fn as the engine itself inside one write to a workspace, on
// behalf of actorID (whose name the events carry). Background jobs use it
// for work no member asked for directly: rules, cycle roll-overs, imports.
func (e *Engine) System(ctx context.Context, workspaceID, actorID string, fn func(*Sys) error) error {
	var seq int64
	err := e.st.Write(ctx, workspaceID, func(tx store.Tx) error {
		var m core.Member
		if err := tx.Get(ctx, &m, store.Eq("user_id", actorID)); err != nil {
			return fmt.Errorf("system actor %s: %w", actorID, err)
		}
		c := &cx{Resolver: &Resolver{ctx: ctx, db: tx, actor: m, at: e.now().UnixMilli()}, e: e, tx: tx, ws: workspaceID, system: true,
			change: Change{ID: id.New(), Type: "system"}, notified: map[string]bool{}}
		if err := fn(&Sys{c: c}); err != nil {
			return err
		}
		seq = tx.Seq()
		return nil
	})
	if err == nil && e.OnCommit != nil {
		e.OnCommit(workspaceID, seq)
	}
	return err
}

// Sys is what a system write may do.
type Sys struct{ c *cx }

// Do runs one change type with the given arguments, skipping role checks.
func (s *Sys) Do(changeType string, args any) error {
	h, ok := handlers[changeType]
	if !ok {
		return fmt.Errorf("unknown change type %q", changeType)
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	s.c.change = Change{ID: id.New(), Type: changeType, Args: raw}
	return h.fn(s.c)
}

// Once reports whether this system write already ran under the given id,
// and remembers it if not. With it a background job that is run twice does
// its work once.
func (s *Sys) Once(changeID, what string) (already bool, err error) {
	var prev core.AppliedChange
	err = s.c.tx.Get(s.c.ctx, &prev, store.Eq("id", changeID))
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return false, err
	}
	return false, s.c.tx.Insert(s.c.ctx, core.AppliedChange{WorkspaceID: s.c.ws, ID: changeID, ActorID: s.c.actor.UserID, Type: what,
		ArgsHash: "-", FirstSeq: s.c.tx.Seq(), LastSeq: s.c.tx.Seq(), CreatedAt: s.c.at})
}

// From marks every event of this write as caused by a rule.
func (s *Sys) From(ruleID string) { s.c.origin = ruleID }

// Tx gives a system write direct access to the transaction.
func (s *Sys) Tx() store.Tx { return s.c.tx }

// Emit records an event from a system write.
func (s *Sys) Emit(typ, entityType, entityID, scopeType, scopeID, projectID string, data any) error {
	return s.c.emit(s.c.tx.NextSeq(), typ, entityType, entityID, scopeType, scopeID, projectID, data)
}

// Ref returns the id of the thing the last Do made.
func (s *Sys) Ref() string { return s.c.ref }

// Opt is an optional argument that tells "absent" from "null" from a value,
// which a patch needs: absent leaves the field alone, null clears it.
type Opt[T any] struct {
	Set  bool
	Null bool
	V    T
}

func (o *Opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(bytes.TrimSpace(b)) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

func (o Opt[T]) MarshalJSON() ([]byte, error) {
	if !o.Set || o.Null {
		return []byte("null"), nil
	}
	return json.Marshal(o.V)
}

func slugOK(s string) bool {
	if len(s) < 2 || len(s) > 40 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// checkHandle checks an @handle: what people type to mention someone.
func checkHandle(h string) error {
	if len(h) < 2 || len(h) > 32 {
		return invalid("handle", "a handle is 2 to 32 characters")
	}
	for _, r := range h {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return invalid("handle", "a handle uses lower-case letters, digits, - and _ only: %q", h)
		}
	}
	return nil
}

// checkAsker holds an agent, on a task a person gave to an agent, to that
// person's access: the work runs as the one who asked for it, not with the
// agent's wider access. It is checked where a write to the task is recorded,
// so it covers every kind of change to the task.
func (c *cx) checkAsker(taskID string) error {
	if c.system || c.actor.Kind != core.KindAgent || c.askerOK == nil || c.askerOK[taskID] {
		return nil
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", taskID)); err != nil {
		return nil // the task is gone; there is nothing to hold to
	}
	c.askerOK[taskID] = true
	if t.AskedBy == "" || t.AskedBy == c.actor.UserID {
		return nil
	}
	var m core.Member
	if err := c.tx.Get(c.ctx, &m, store.Eq("user_id", t.AskedBy)); err != nil || m.SuspendedAt != 0 {
		return forbidden("%s was given to an agent by someone who no longer has access here; a person has to assign it again", t.Key)
	}
	min := handlers[c.change.Type].min
	if !m.Role.AtLeast(min) {
		return forbidden("%s needs the %s role; @%s, who asked for the work on %s, is a %s", c.change.Type, min, m.Handle, t.Key, m.Role)
	}
	if m.Scope != nil {
		if m.Scope.ReadOnly {
			return forbidden("@%s, who asked for the work on %s, may only read", m.Handle, t.Key)
		}
		if len(m.Scope.Projects) > 0 {
			if !contains(m.Scope.Projects, t.ProjectID) {
				return forbidden("@%s, who asked for the work on %s, has no access to its project", m.Handle, t.Key)
			}
			c.scope.Projects = narrow(c.scope.Projects, m.Scope.Projects)
		}
	}
	return nil
}

// askedBy works out who a task is worked for once its assignee is set: the
// person who gave it to an agent. An agent passing it on keeps the person it
// came from; a task a person holds is worked for nobody else.
func (c *cx) askedBy(t core.Task) (string, error) {
	if t.AssigneeID == "" {
		return "", nil
	}
	to, err := c.memberRef("assignee", t.AssigneeID)
	if err != nil || to.Kind != core.KindAgent {
		return "", err
	}
	switch {
	case c.asker != "":
		return c.asker, nil
	case !c.system && c.actor.Kind != core.KindAgent:
		return c.actor.UserID, nil
	}
	return t.AskedBy, nil
}
