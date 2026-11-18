// Applying a change, or a batch of them, in one transaction.

package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"

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
	// Quiet marks history being brought in (an import): the change tells
	// nobody, no inbox item and no wake-up, though its events are in the
	// feed as usual, each marked "quiet". Only an admin may send it.
	Quiet bool `json:"quiet,omitempty"`
	// Undoes is the id of an earlier change that this one takes back (a
	// person's Cmd+Z). Its events say so, and when the earlier change was
	// the same member's of a moment ago, what it put in inboxes and nobody
	// has read is taken out again, and this change puts nothing in them
	// (see takeBackNews).
	Undoes string `json:"undoes,omitempty"`
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
	// Warnings say what the change did that the caller may not have meant:
	// a page's edit that took away the words a comment thread was on.
	Warnings []string `json:"warnings,omitempty"`
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

// maxBatch is the most changes one batch holds.
const maxBatch = 500

// Batch runs several changes in one transaction: all apply or none do. With
// dryRun the changes are checked and their events returned, and nothing is
// kept.
func (e *Engine) Batch(ctx context.Context, workspaceID string, actor Actor, changes []Change, dryRun bool) ([]*Result, error) {
	if err := checkBatch(changes); err != nil {
		return nil, err
	}
	results := make([]*Result, len(changes))
	var lastSeq int64
	err := e.st.Write(ctx, workspaceID, func(raw store.Tx) error {
		run, err := e.startBatch(ctx, newMemoTx(raw), actor)
		if err != nil {
			return err
		}
		for i, ch := range changes {
			res, err := run.apply(ch)
			if err != nil {
				return refusedAt(i, ch, err)
			}
			results[i] = res
		}
		lastSeq = run.tx.Seq()
		if dryRun {
			// A dry run is undone by failing the transaction: the error
			// rolls back every write, and is not reported.
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

// checkBatch refuses a batch that is empty, too long, or has a change with
// no id or of an unknown type, before anything is read.
func checkBatch(changes []Change) error {
	if len(changes) == 0 {
		return invalid("changes", "send at least one change")
	}
	if len(changes) > maxBatch {
		return invalid("changes", "a batch holds at most 500 changes; this one has %d", len(changes))
	}
	for i, ch := range changes {
		if !id.Valid(ch.ID) {
			return withIndex(i, invalid("id", "a change needs an id made by the caller (a lower-case UUID); resending the same id is then safe"))
		}
		if _, ok := handlers[ch.Type]; !ok {
			return withIndex(i, oneOf("type", "change type", ch.Type, ChangeTypes()))
		}
	}
	return nil
}

// refusedAt says which change of a batch failed: a refusal carries its
// position, anything else names it.
func refusedAt(i int, ch Change, err error) error {
	if ee, ok := errors.AsType[*Error](err); ok {
		return withIndex(i, ee)
	}
	if errors.Is(err, store.ErrNotFound) {
		return withIndex(i, &Error{Code: CodeNotFound, Message: err.Error()})
	}
	return fmt.Errorf("change %d (%s): %w", i, ch.Type, err)
}

// batch is one run of Batch: one actor's changes in one transaction, with
// what is known of the actor once it has started.
type batch struct {
	ctx    context.Context
	e      *Engine
	tx     store.Tx
	member core.Member // the actor
	scope  core.Scope  // what the actor's membership and credential allow
	now    int64
}

// startBatch starts a run in tx: it checks that the actor may write to the
// workspace at all, and works out how far their credential reaches.
func (e *Engine) startBatch(ctx context.Context, tx store.Tx, actor Actor) (*batch, error) {
	b := &batch{ctx: ctx, e: e, tx: tx}
	there, err := store.Find(ctx, tx, &b.member, store.Eq("user_id", actor.UserID), store.Null("removed_at"))
	if err != nil {
		return nil, err
	}
	if !there {
		return nil, forbidden("you are not a member of this workspace")
	}
	if b.member.SuspendedAt != 0 {
		return nil, forbidden("your membership is suspended")
	}
	b.scope = Effective(b.member, actor)
	b.now = e.now().UnixMilli()
	return b, nil
}

// Effective is how far a member reaches through the credential it acts
// with: the membership's scope (its projects, read-only, the changes that
// need approval), narrowed by the credential's (read-only, some projects).
// The engine holds every change to it; a write the server makes outside the
// engine asks it the same.
func Effective(m core.Member, a Actor) core.Scope {
	var scope core.Scope
	if m.Scope != nil {
		scope = *m.Scope
		scope.Projects = slices.Clone(m.Scope.Projects)
		scope.NeedsApproval = slices.Clone(m.Scope.NeedsApproval)
	}
	if a.ReadOnly {
		scope.ReadOnly = true
	}
	if len(a.Projects) > 0 {
		scope.Projects = intersectProjects(scope.Projects, a.Projects)
	}
	return scope
}

// Permit makes a write the server makes outside the engine that stands for
// a change (an invitation stands for member.add), allowed exactly as Batch
// allows that change: a member, not suspended, with the role the change
// needs, not read-only, and with an approval when the actor must get one
// for this kind of change. No handler runs; write runs in its place, in the
// same transaction as the approval is used up in, so an approval is spent
// only on a write made, and a write that fails undoes all of it. write is
// given how far the actor reaches (Effective, narrowed by an approver's
// reach), which what it writes must stay within.
func (e *Engine) Permit(ctx context.Context, workspaceID string, actor Actor, ch Change, write func(tx store.Tx, reach core.Scope) error) error {
	h, ok := handlers[ch.Type]
	if !ok {
		return oneOf("type", "change type", ch.Type, ChangeTypes())
	}
	if ch.ID == "" {
		ch.ID = id.New()
	}
	var seq int64
	err := e.st.Write(ctx, workspaceID, func(raw store.Tx) error {
		run, err := e.startBatch(ctx, newMemoTx(raw), actor)
		if err != nil {
			return err
		}
		c, err := run.authorize(ch, h)
		if err != nil {
			return err
		}
		if err := write(run.tx, c.scope); err != nil {
			return err
		}
		seq = run.tx.Seq()
		return nil
	})
	if err != nil {
		return err
	}
	if e.OnCommit != nil {
		e.OnCommit(workspaceID, seq)
	}
	return nil
}

// apply runs one change of the batch, or answers it from the first time
// its id was used.
func (b *batch) apply(ch Change) (*Result, error) {
	h := handlers[ch.Type]
	hash := argsHash(ch)
	if res, dup, err := b.resent(ch, hash); dup || err != nil {
		return res, err
	}
	c, err := b.authorize(ch, h)
	if err != nil {
		return nil, err
	}
	if err := c.takeBackNews(); err != nil {
		return nil, err
	}
	if err := h.fn(c); err != nil {
		return nil, err
	}
	return b.remember(c, ch, hash)
}

// authorize checks that the batch's actor may make a change of kind h, and
// gives the context it runs in: the role, quiet, the member it is made
// for, read-only, and the approval it needs, which is used up.
func (b *batch) authorize(ch Change, h handler) (*cx, error) {
	if !b.member.Role.AtLeast(h.min) {
		return nil, forbidden("%s needs the %s role; you are a %s", ch.Type, h.min, b.member.Role)
	}
	if ch.Quiet && !b.member.Role.AtLeast(core.RoleAdmin) {
		return nil, forbidden("quiet is for an admin bringing in history; a change by a %s tells those it concerns", b.member.Role)
	}
	scope := b.scope
	askerID, err := b.checkFor(ch, h, &scope)
	if err != nil {
		return nil, err
	}
	if scope.ReadOnly {
		return nil, forbidden("this credential is read-only")
	}
	c := &cx{Resolver: b.resolver(), e: b.e, tx: b.tx, ws: b.tx.WorkspaceID(), scope: scope,
		change: ch, notified: map[string]bool{}, asker: askerID, askerOK: map[string]bool{}, quiet: ch.Quiet}
	if slices.Contains(scope.NeedsApproval, ch.Type) {
		if err := c.checkApproval(); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func (b *batch) resolver() *Resolver {
	return &Resolver{ctx: b.ctx, db: b.tx, actor: b.member, at: b.now}
}

// resent answers a change whose id was already applied (dup) with what it
// did then, and refuses one whose id was used for another change. A new id
// is neither.
func (b *batch) resent(ch Change, hash string) (res *Result, dup bool, err error) {
	var prev core.AppliedChange
	ok, err := store.Find(b.ctx, b.tx, &prev, store.Eq("id", ch.ID))
	if !ok {
		return nil, false, err
	}
	if prev.Type != ch.Type || prev.ArgsHash != hash || prev.ActorID != b.member.UserID {
		return nil, false, conflictErr("change id %s was already used for a different change; use a new id", ch.ID)
	}
	return &Result{ChangeID: ch.ID, Type: ch.Type, Duplicate: true, FirstSeq: prev.FirstSeq, Seq: prev.LastSeq, Ref: prev.Ref, Key: prev.Key}, true, nil
}

// checkFor holds a change made "for" a member to what that member may do,
// narrowing scope to their projects. It returns the member's id.
func (b *batch) checkFor(ch Change, h handler, scope *core.Scope) (string, error) {
	if ch.For == "" {
		return "", nil
	}
	asker, err := b.resolver().memberRef("for", ch.For)
	if err != nil {
		return "", err
	}
	if err := holdTo(asker, "who asked for it", ch.Type, h, scope); err != nil {
		return "", err
	}
	return asker.UserID, nil
}

// holdTo holds a change of type typ to what another member could do (the
// one it is made for, the one who approved it; their part names them in a
// refusal): it is refused when they are suspended, of a lower role than
// the change needs, or may only read, and scope is narrowed to their
// projects.
func holdTo(m core.Member, part, typ string, h handler, scope *core.Scope) error {
	if m.SuspendedAt != 0 || !m.Role.AtLeast(h.min) {
		return forbidden("%s needs the %s role; @%s, %s, is a %s", typ, h.min, m.Handle, part, m.Role)
	}
	if m.Scope == nil {
		return nil
	}
	if m.Scope.ReadOnly {
		return forbidden("@%s, %s, may only read", m.Handle, part)
	}
	if len(m.Scope.Projects) > 0 {
		scope.Projects = intersectProjects(scope.Projects, m.Scope.Projects)
	}
	return nil
}

// remember records that the change was applied, at the positions of its
// events, so that sending it again is answered and not applied twice.
func (b *batch) remember(c *cx, ch Change, hash string) (*Result, error) {
	res := &Result{ChangeID: ch.ID, Type: ch.Type, Events: c.events, Ref: c.ref, Key: c.key, Warnings: c.warnings}
	applied := core.AppliedChange{WorkspaceID: c.ws, ID: ch.ID, ActorID: b.member.UserID, Type: ch.Type, ArgsHash: hash, CreatedAt: b.now, Ref: c.ref, Key: c.key}
	if len(c.events) > 0 {
		applied.FirstSeq = c.events[0].Seq
		applied.LastSeq = c.events[len(c.events)-1].Seq
	} else {
		// Nothing changed (an update to the values already there). The
		// change is still remembered, at the position it was checked.
		applied.FirstSeq, applied.LastSeq = b.tx.Seq(), b.tx.Seq()
	}
	res.FirstSeq, res.Seq = applied.FirstSeq, applied.LastSeq
	return res, b.tx.Insert(b.ctx, applied)
}

// checkApproval makes sure the change comes with an approved decision that
// was opened for this kind of change by this actor, and holds the change
// to what the one who approved it could do: a change approved by someone
// who reaches some projects, by their membership now or by the credential
// they answered with then, touches those alone.
func (c *cx) checkApproval() error {
	need := &Error{Code: CodeNeedsApproval, Message: fmt.Sprintf(
		`%s needs approval. Open one with decision.open {"kind": "approval", "action": %q, "task": …, "question": …, "ask": …}, `+
			`with "args" set to this change's arguments, wait for the answer, then resend this same change with "approval": "<decision id>"`, c.change.Type, c.change.Type)}
	if c.change.Approval == "" {
		return need
	}
	var approval core.Decision
	if ok, err := store.Find(c.ctx, c.tx, &approval, store.Eq("id", c.change.Approval), store.Live); !ok {
		if err != nil {
			return err
		}
		return need
	}
	switch {
	case approval.Kind != core.DecisionApproval || approval.Action != c.change.Type:
		need.Message = fmt.Sprintf("decision %s is not an approval for %s", approval.ID, c.change.Type)
	case approval.CreatedBy != c.actor.UserID:
		need.Message = "that approval was asked for by someone else"
	case approval.State == core.StateOpen:
		need.Message = "that approval has not been answered yet"
	case approval.Outcome != core.OutcomeApproved:
		need.Code, need.Message = CodeForbidden, "that approval was declined"
	case approval.ActionUsedAt != 0:
		need.Message = "that approval was already used; an approval covers one change, once. Ask again for this one"
	case !sameArgs(approval.ActionArgs, c.change.Args):
		need.Message = "that approval was given for different arguments (" + string(approval.ActionArgs) + "); it covers that change and no other. Ask again for this one"
	case approval.ApproverProjects == nil:
		need.Message = "that approval was given before approvals kept which projects their giver could reach, so how far it reaches is unknown; ask again for this one"
	default:
		var approver core.Member
		there, err := store.Find(c.ctx, c.tx, &approver, store.Eq("user_id", approval.DecidedBy), store.Null("removed_at"))
		if err != nil {
			return err
		}
		if !there {
			return forbidden("the one who approved this is no longer a member here; ask again")
		}
		if err := holdTo(approver, "who approved it", c.change.Type, handlers[c.change.Type], &c.scope); err != nil {
			return err
		}
		if len(approval.ApproverProjects) > 0 {
			c.scope.Projects = intersectProjects(c.scope.Projects, approval.ApproverProjects)
		}
		// Used up, in the same write as the change it allows; and said in
		// the feed, so the approval shows as used wherever it is open.
		seq := c.tx.NextSeq()
		if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"action_used_at": c.at, "updated_seq": seq}, store.Eq("id", approval.ID)); err != nil {
			return err
		}
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", approval.TaskID)); err != nil {
			return err
		}
		return c.emit(event{seq: seq, typ: "decision.updated", entity: "decision", entityID: approval.ID, place: inTask(t), data: core.EventData{ID: approval.ID, Changes: map[string]core.FieldChange{"action_used_at": {To: c.at}}}})
	}
	return need
}

// sameArgs reports whether two sets of change arguments say the same thing,
// whatever their spacing or key order.
func sameArgs(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
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

// applyNested runs another change type inside this one, as the same actor.
func (c *cx) applyNested(changeType string, args any) error {
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	saved, ref, key := c.change, c.ref, c.key
	c.change = Change{ID: saved.ID, Type: changeType, Args: raw}
	err = handlers[changeType].fn(c)
	c.subRef = c.ref
	c.change, c.ref, c.key = saved, ref, key
	return err
}
