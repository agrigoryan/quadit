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
}

// Result says what a change produced.
type Result struct {
	ChangeID string `json:"change_id"`
	// Seq is the feed position that includes this change. A reader that has
	// reached Seq has seen everything the change did.
	Seq      int64 `json:"seq"`
	FirstSeq int64 `json:"first_seq"`
	// Duplicate is true when this id was already applied; nothing was
	// written this time.
	Duplicate bool         `json:"duplicate,omitempty"`
	Events    []core.Event `json:"events,omitempty"`
}

// Error codes. Every refusal has one, so a caller can branch without reading
// the message.
const (
	CodeInvalid   = "invalid"   // the change itself is wrong; fix it and resend
	CodeForbidden = "forbidden" // the actor may not do this
	CodeNotFound  = "not_found" // something the change refers to does not exist
	CodeConflict  = "conflict"  // it collides with what is there (a taken key, an answered decision)
	CodeStale     = "stale"     // it was based on an older version than the current one
)

// Error is a refusal that tells the caller how to fix the change.
type Error struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Field   string   `json:"field,omitempty"`
	Allowed []string `json:"allowed,omitempty"` // the values that would have been accepted
}

func (e *Error) Error() string {
	msg := e.Code + ": " + e.Message
	if len(e.Allowed) > 0 {
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

// missing turns a store "not found" into a refusal naming what was missing.
func missing(err error, what, ref string) error {
	if errors.Is(err, store.ErrNotFound) {
		return &Error{Code: CodeNotFound, Message: fmt.Sprintf("%s %q does not exist in this workspace", what, ref)}
	}
	return err
}

// Engine applies changes to one store.
type Engine struct {
	st  store.Store
	now func() time.Time
}

// New returns an engine over st.
func New(st store.Store) *Engine {
	return &Engine{st: st, now: time.Now}
}

// Store returns the store, for reads.
func (e *Engine) Store() store.Store { return e.st }

// handler is one kind of change.
type handler struct {
	min core.Role // the least role that may send it
	fn  func(*cx) error
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

// cx is what a handler works with: one change, one actor, one transaction.
type cx struct {
	ctx    context.Context
	tx     store.Tx
	ws     string
	actor  core.Member
	at     int64
	change Change
	events []core.Event
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
		return invalid("args", "%s: %v", c.change.Type, err)
	}
	return nil
}

// emit records an event under a sequence number from this transaction.
func (c *cx) emit(seq int64, typ, entityType, entityID, scopeType, scopeID, projectID string, data any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	ev := core.Event{
		WorkspaceID: c.ws, Seq: seq, At: c.at, ActorID: c.actor.UserID, ChangeID: c.change.ID,
		Type: typ, EntityType: entityType, EntityID: entityID, ScopeType: scopeType, ScopeID: scopeID,
		ProjectID: projectID, Data: raw,
	}
	if err := c.tx.Emit(c.ctx, ev); err != nil {
		return err
	}
	c.events = append(c.events, ev)
	return nil
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

// Apply runs one change as the given user.
func (e *Engine) Apply(ctx context.Context, workspaceID, actorID string, ch Change) (*Result, error) {
	if !id.Valid(ch.ID) {
		return nil, invalid("id", "a change needs an id made by the caller (a lower-case UUID); resending the same id is then safe")
	}
	h, ok := handlers[ch.Type]
	if !ok {
		return nil, &Error{Code: CodeInvalid, Field: "type", Message: fmt.Sprintf("unknown change type %q", ch.Type), Allowed: ChangeTypes()}
	}
	hash := argsHash(ch)
	res := &Result{ChangeID: ch.ID}

	err := e.st.Write(ctx, workspaceID, func(tx store.Tx) error {
		prev, found, err := tx.Change(ctx, ch.ID)
		if err != nil {
			return err
		}
		if found {
			if prev.Type != ch.Type || prev.ArgsHash != hash || prev.ActorID != actorID {
				return conflictErr("change id %s was already used for a different change; use a new id", ch.ID)
			}
			res.Duplicate, res.FirstSeq, res.Seq = true, prev.FirstSeq, prev.LastSeq
			return nil
		}

		actor, err := tx.Member(ctx, workspaceID, actorID)
		if errors.Is(err, store.ErrNotFound) {
			return forbidden("you are not a member of this workspace")
		}
		if err != nil {
			return err
		}
		if !actor.Role.AtLeast(h.min) {
			return forbidden("%s needs the %s role; you are a %s", ch.Type, h.min, actor.Role)
		}

		c := &cx{ctx: ctx, tx: tx, ws: workspaceID, actor: actor, at: e.now().UnixMilli(), change: ch}
		if err := h.fn(c); err != nil {
			return err
		}
		res.Events = c.events
		applied := store.AppliedChange{ID: ch.ID, ActorID: actorID, Type: ch.Type, ArgsHash: hash, At: c.at}
		if len(c.events) > 0 {
			applied.FirstSeq = c.events[0].Seq
			applied.LastSeq = c.events[len(c.events)-1].Seq
		} else {
			// Nothing changed (an update to the values already there). The
			// change is still remembered, at the position it was checked.
			applied.FirstSeq, applied.LastSeq = tx.Seq(), tx.Seq()
		}
		res.FirstSeq, res.Seq = applied.FirstSeq, applied.LastSeq
		return tx.SaveChange(ctx, applied)
	})
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			var ee *Error
			if !errors.As(err, &ee) {
				return nil, &Error{Code: CodeNotFound, Message: err.Error()}
			}
		}
		return nil, err
	}
	return res, nil
}

func argsHash(ch Change) string {
	// Compact first, so the same arguments with different spacing hash alike.
	var buf bytes.Buffer
	if err := json.Compact(&buf, ch.Args); err != nil {
		buf.Reset()
		buf.Write(ch.Args)
	}
	sum := sha256.Sum256(append([]byte(ch.Type+"\n"), buf.Bytes()...))
	return hex.EncodeToString(sum[:])
}

// Bootstrap makes a person, a workspace and that person's owner membership.
// It is how a new install, or a new workspace on one, starts.
type BootstrapArgs struct {
	OwnerName     string
	OwnerEmail    string
	OwnerHandle   string
	WorkspaceSlug string
	WorkspaceName string
}

func (e *Engine) Bootstrap(ctx context.Context, a BootstrapArgs) (core.Workspace, core.User, error) {
	at := e.now().UnixMilli()
	email := strings.ToLower(strings.TrimSpace(a.OwnerEmail))
	if email == "" || !strings.Contains(email, "@") {
		return core.Workspace{}, core.User{}, invalid("owner_email", "an owner needs an email address")
	}
	if err := checkHandle(a.OwnerHandle); err != nil {
		return core.Workspace{}, core.User{}, err
	}
	if !slugOK(a.WorkspaceSlug) {
		return core.Workspace{}, core.User{}, invalid("workspace_slug", "a slug is 2 to 40 lower-case letters, digits or dashes")
	}
	owner, err := e.st.UserByEmail(ctx, email)
	if errors.Is(err, store.ErrNotFound) {
		owner = core.User{ID: id.New(), Kind: core.KindPerson, Name: strings.TrimSpace(a.OwnerName), Email: email, CreatedAt: at}
		if owner.Name == "" {
			return core.Workspace{}, core.User{}, invalid("owner_name", "an owner needs a name")
		}
		err = e.st.CreateUser(ctx, owner)
	}
	if err != nil {
		return core.Workspace{}, core.User{}, err
	}
	ws := core.Workspace{ID: id.New(), Slug: a.WorkspaceSlug, Name: strings.TrimSpace(a.WorkspaceName), CreatedAt: at}
	if ws.Name == "" {
		ws.Name = ws.Slug
	}
	m := core.Member{WorkspaceID: ws.ID, UserID: owner.ID, Role: core.RoleOwner, Handle: a.OwnerHandle, CreatedAt: at}
	if err := e.st.CreateWorkspace(ctx, ws, m); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return core.Workspace{}, core.User{}, conflictErr("a workspace with the slug %q already exists", ws.Slug)
		}
		return core.Workspace{}, core.User{}, err
	}
	return ws, owner, nil
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
