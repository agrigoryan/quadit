// An agent proving it reached Quadit from inside its tool (Member.ConnectedAt).

package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// markConnected records, once, that agent m has proven it reached Quadit
// from inside its tool, and tells the workspace as it tells any change to
// a member. Anything else, a person or an agent already connected, is left
// as it is.
func (c *cx) markConnected(m core.Member) error {
	if m.Kind != core.KindAgent || m.ConnectedAt != 0 {
		return nil
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "members", map[string]any{"connected_at": c.at, "updated_seq": seq}, store.Eq("user_id", m.UserID)); err != nil {
		return err
	}
	return c.emit(event{seq: seq, typ: "member.updated", entity: "member", entityID: m.UserID, place: inWorkspace(c.ws),
		data: core.EventData{ID: m.UserID, Changes: map[string]core.FieldChange{"connected_at": {To: c.at}}}})
}

// Connected records that the actor of this system write, an agent, has
// proven it reached Quadit from inside its tool (a connect code it gave
// back, its listener's lease). It is set once: later calls change nothing.
func (s *Sys) Connected() error {
	var m core.Member
	if err := s.c.tx.Get(s.c.ctx, &m, store.Eq("user_id", s.c.actor.UserID)); err != nil {
		return err
	}
	return s.c.markConnected(m)
}
