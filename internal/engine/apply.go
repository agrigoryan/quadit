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
			return nil, withIndex(i, invalid("id", "a change needs an id made by the caller (a lower-case UUID); resending the same id is then safe"))
		}
		if _, ok := handlers[ch.Type]; !ok {
			return nil, withIndex(i, oneOf("type", "change type", ch.Type, ChangeTypes()))
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
			scope.Projects = intersectProjects(scope.Projects, actor.Projects)
		}
		now := e.now().UnixMilli()
		for i, ch := range changes {
			res, err := e.applyOne(ctx, tx, m, scope, now, ch, dryRun)
			if err != nil {
				var ee *Error
				if errors.As(err, &ee) {
					return withIndex(i, ee)
				}
				if errors.Is(err, store.ErrNotFound) {
					return withIndex(i, &Error{Code: CodeNotFound, Message: err.Error()})
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
		res.Ref, res.Key = prev.Ref, prev.Key
		return res, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if !m.Role.AtLeast(h.min) {
		return nil, forbidden("%s needs the %s role; you are a %s", ch.Type, h.min, m.Role)
	}
	if ch.Quiet && !m.Role.AtLeast(core.RoleAdmin) {
		return nil, forbidden("quiet is for an admin bringing in history; a change by a %s tells those it concerns", m.Role)
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
				scope.Projects = intersectProjects(scope.Projects, asker.Scope.Projects)
			}
		}
	}
	if scope.ReadOnly {
		return nil, forbidden("this credential is read-only")
	}
	c := &cx{Resolver: &Resolver{ctx: ctx, db: tx, actor: m, at: now}, e: e, tx: tx, ws: tx.WorkspaceID(), scope: scope,
		change: ch, notified: map[string]bool{}, asker: askerID, askerOK: map[string]bool{}, quiet: ch.Quiet}
	if contains(scope.NeedsApproval, ch.Type) {
		if err := c.checkApproval(); err != nil {
			return nil, err
		}
	}
	if err := h.fn(c); err != nil {
		return nil, err
	}
	res.Events, res.Ref, res.Key = c.events, c.ref, c.key
	applied := core.AppliedChange{WorkspaceID: c.ws, ID: ch.ID, ActorID: m.UserID, Type: ch.Type, ArgsHash: hash, CreatedAt: now, Ref: c.ref, Key: c.key}
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
			`with "args" set to this change's arguments, wait for the answer, then resend this same change with "approval": "<decision id>"`, c.change.Type, c.change.Type)}
	if c.change.Approval == "" {
		return need
	}
	var d core.Decision
	if ok, err := found(c.tx.Get(c.ctx, &d, store.Eq("id", c.change.Approval), store.Live)); !ok {
		if err != nil {
			return err
		}
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
	case d.ActionUsedAt != 0:
		need.Message = "that approval was already used; an approval covers one change, once. Ask again for this one"
	case !sameArgs(d.ActionArgs, c.change.Args):
		need.Message = "that approval was given for different arguments (" + string(d.ActionArgs) + "); it covers that change and no other. Ask again for this one"
	default:
		// Used up, in the same write as the change it allows; and said in
		// the feed, so the approval shows as used wherever it is open.
		seq := c.tx.NextSeq()
		if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"action_used_at": c.at, "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
			return err
		}
		var t core.Task
		if err := c.tx.Get(c.ctx, &t, store.Eq("id", d.TaskID)); err != nil {
			return err
		}
		return c.emit(seq, "decision.updated", "decision", d.ID, "task", t.ID, t.ProjectID,
			map[string]any{"id": d.ID, "changes": map[string]core.FieldChange{"action_used_at": {To: c.at}}})
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
