// cx, what a handler works with, and the events it records.

package engine

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

const (
	// taskPage is how many tasks eachTask reads at a time.
	taskPage = 500
	// msPerMinute turns minutes into the Unix milliseconds times are kept
	// in (cx.at and every stored time).
	msPerMinute = 60_000
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
	// ref and key are the change's answer (Result.Ref, Result.Key): created,
	// save and trash set ref to the row they write; a handler sets key.
	ref, key string
	subRef   string // the ref of the last change run with sub
	notified map[string]bool
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
	// noNews is set for a change that puts nothing in an inbox: the undo of
	// a change made a moment ago (takeBackNews).
	noNews bool
	// asker is the member named with "for": the one this change is made for.
	asker string
	// askerOK remembers the tasks whose asker was already checked.
	askerOK map[string]bool
	// warnings are what the change did that its caller may not have meant
	// (Result.Warnings).
	warnings []string
}

// warn tells the caller, with the change's answer, of something the change
// did that they may not have meant.
func (c *cx) warn(format string, a ...any) {
	c.warnings = append(c.warnings, fmt.Sprintf(format, a...))
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
	data     core.EventData
}

// eachTask calls fn with every task the filter selects, however many there
// are. They are read a page at a time in id order, each page starting
// after the last task of the one before, so fn may change a task, even so
// that the filter no longer selects it, and no task is missed or met twice.
// The filter's sort and limit are its own.
func (c *cx) eachTask(f store.TaskFilter, fn func(t core.Task) error) error {
	f.Sort, f.Limit, f.Offset = "", taskPage, 0
	for {
		page, err := c.tx.Tasks(c.ctx, f)
		if err != nil {
			return err
		}
		for _, t := range page {
			if err := fn(t); err != nil {
				return err
			}
		}
		if len(page) < taskPage {
			return nil
		}
		f.After = []any{page[len(page)-1].ID}
	}
}

// emit records an event, after checking that the actor may write where it
// belongs.
func (c *cx) emit(e event) error {
	if e.place.projectID != "" && !c.system && len(c.scope.Projects) > 0 && !slices.Contains(c.scope.Projects, e.place.projectID) {
		return forbidden("your access does not include this project")
	}
	if e.place.scopeType == "task" {
		if err := c.checkAsker(e.place.scopeID); err != nil {
			return err
		}
	}
	// Every event says which rule caused it, whether it was only brought in, and which change it takes back.
	e.data.Rule, e.data.Quiet, e.data.Undoes = c.origin, c.quiet, c.change.Undoes
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

// created emits "<entity>.created" carrying the whole new row, and makes
// the row the change's answer (c.ref).
func (c *cx) created(seq int64, entity, entityID string, where place, row any) error {
	c.ref = entityID
	return c.emit(event{seq: seq, typ: entity + ".created", entity: entity, entityID: entityID, place: where, data: core.EventData{Row: row}})
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
