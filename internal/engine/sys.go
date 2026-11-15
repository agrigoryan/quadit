package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

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
func (s *Sys) Emit(typ, entityType, entityID, scopeType, scopeID, projectID string, data any) error { //nolint:revive // argument-limit: exported and called by the server, so its signature stays this round
	return s.c.emit(event{seq: s.c.tx.NextSeq(), typ: typ, entity: entityType, entityID: entityID, place: place{scopeType: scopeType, scopeID: scopeID, projectID: projectID}, data: data})
}

// Ref returns the id of the thing the last Do made.
func (s *Sys) Ref() string { return s.c.ref }
