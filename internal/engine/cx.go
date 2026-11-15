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

// place is where in the workspace an event belongs: its scope (a task, a
// page, a project, the workspace), and the project whose access decides who
// may see it ("" for none).
type place struct {
	scopeType, scopeID, projectID string
}

// inTask places an event in a task.
func inTask(t core.Task) place {
	return place{scopeType: "task", scopeID: t.ID, projectID: t.ProjectID}
}

// inDoc places an event in a page.
func inDoc(d core.Doc) place { return place{scopeType: "doc", scopeID: d.ID, projectID: d.ProjectID} }

// inProject places an event in a project.
func inProject(projectID string) place {
	return place{scopeType: "project", scopeID: projectID, projectID: projectID}
}

// inWorkspace places an event in the workspace as a whole.
func inWorkspace(wsID string) place { return place{scopeType: "workspace", scopeID: wsID} }

// inProjectOrWorkspace places an event in a project, or in the workspace
// when projectID is "".
func (c *cx) inProjectOrWorkspace(projectID string) place {
	if projectID != "" {
		return inProject(projectID)
	}
	return inWorkspace(c.ws)
}

// event is one event a change records.
type event struct {
	seq      int64  // its position in the feed, from this transaction
	typ      string // what happened: "task.updated"
	entity   string // the kind of thing it happened to: "task"
	entityID string
	place    place
	audience string // the one member who may see it; "" for all who may see its place
	data     any
}

// emit records an event, after checking that the actor may write where it
// belongs.
func (c *cx) emit(e event) error {
	if e.place.projectID != "" && !c.system && len(c.scope.Projects) > 0 && !contains(c.scope.Projects, e.place.projectID) {
		return forbidden("your access does not include this project")
	}
	if e.place.scopeType == "task" {
		if err := c.checkAsker(e.place.scopeID); err != nil {
			return err
		}
	}
	if m, ok := e.data.(map[string]any); ok && c.origin != "" {
		m["rule"] = c.origin
	}
	if m, ok := e.data.(map[string]any); ok && c.quiet {
		m["quiet"] = true // the feed shows it was brought in, not done now
	}
	raw, err := json.Marshal(e.data)
	if err != nil {
		return err
	}
	ev := core.Event{
		WorkspaceID: c.ws, Seq: e.seq, At: c.at, ActorID: c.actor.UserID, ChangeID: c.change.ID,
		Type: e.typ, EntityType: e.entity, EntityID: e.entityID, ScopeType: e.place.scopeType, ScopeID: e.place.scopeID,
		ProjectID: e.place.projectID, AudienceID: e.audience, Data: raw,
	}
	if err := c.tx.Emit(c.ctx, ev); err != nil {
		return err
	}
	c.events = append(c.events, ev)
	return nil
}

// created emits "<entity>.created" carrying the whole new row.
func (c *cx) created(seq int64, entity, entityID string, where place, row any) error {
	c.ref = entityID
	return c.emit(event{seq: seq, typ: entity + ".created", entity: entity, entityID: entityID, place: where, data: map[string]any{"row": row}})
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
