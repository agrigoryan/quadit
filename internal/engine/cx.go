package engine

import (
	"encoding/json"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

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
	// quiet is set for a change that tells nobody (Change.Quiet).
	quiet bool
	// asker is the member named with "for": the one this change is made for.
	asker string
	// askerOK remembers the tasks whose asker was already checked.
	askerOK map[string]bool
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
	if m, ok := data.(map[string]any); ok && c.quiet {
		m["quiet"] = true // the feed shows it was brought in, not done now
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
