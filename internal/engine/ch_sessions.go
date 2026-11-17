// session.start and session.update: an agent's work sessions.

package engine

import (
	"encoding/json"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("session.start", core.RoleMember, sessionStart)
	register("session.update", core.RoleMember, sessionUpdate)
}

type sessionStartArgs struct {
	ID           string `json:"id"`
	Task         string `json:"task"`
	Title        string `json:"title"`
	Instructions string `json:"instructions"` // what the run was asked to do
}

// sessionStart records that an agent started a run of work, on a task or
// not.
func sessionStart(c *cx, a sessionStartArgs) error {
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	s := core.AgentSession{ID: sid, WorkspaceID: c.ws, AgentID: c.actor.UserID, Title: a.Title, Instructions: a.Instructions,
		State: core.AgentSessionRunning, StartedAt: c.at, UpdatedSeq: seq}
	where, key := inWorkspace(c.ws), ""
	if a.Task != "" {
		t, err := c.task("task", a.Task)
		if err != nil {
			return err
		}
		s.TaskID, where, key = t.ID, inTask(t), t.Key
		if s.Title == "" {
			s.Title = t.Title
		}
	}
	if err := c.tx.Insert(c.ctx, s); err != nil {
		return alreadyInUse(err, "id", sid)
	}
	c.ref = s.ID
	return c.emit(event{seq: seq, typ: "session.created", entity: "session", entityID: s.ID, place: where, data: core.EventData{Row: s, Key: &key}})
}

type sessionUpdateArgs struct {
	ID      string      `json:"id" quadit:"required"`
	Title   Opt[string] `json:"title"`
	Summary Opt[string] `json:"summary"`
	// State: running, done, failed or stopped. Anything but running ends
	// the session.
	State Opt[string] `json:"state"`
	// AddSteps appends to what the run did, in order.
	AddSteps []json.RawMessage `json:"add_steps"`
	// AddLinks appends commits, files or URLs the run produced.
	AddLinks []json.RawMessage `json:"add_links"`
}

// appendJSON adds items to a JSON list kept in a row.
func appendJSON(cur json.RawMessage, add []json.RawMessage) (json.RawMessage, error) {
	var list []json.RawMessage
	if len(cur) > 0 {
		if err := json.Unmarshal(cur, &list); err != nil {
			return nil, err
		}
	}
	list = append(list, add...)
	return json.Marshal(list)
}

// sessionUpdate records how an agent's run goes: its state, steps and
// links.
func sessionUpdate(c *cx, a sessionUpdateArgs) error {
	s, err := loadLive[core.AgentSession](c, "session", "id", a.ID)
	if err != nil {
		return err
	}
	if s.AgentID != c.actor.UserID && !c.system {
		return forbidden("a session is updated by the agent that started it")
	}
	p := newPatch()
	p.setText("title", a.Title, &s.Title)
	p.setText("summary", a.Summary, &s.Summary)
	if a.State.Set {
		states := []string{core.AgentSessionRunning, core.AgentSessionDone, core.AgentSessionFailed, core.AgentSessionStopped}
		if !slices.Contains(states, a.State.V) {
			return oneOf("state", "session state", a.State.V, states)
		}
		p.setText("state", a.State, &s.State)
		if s.State != core.AgentSessionRunning && s.EndedAt == 0 {
			p.put("ended_at", int64(0), c.at)
		}
	}
	// The event carries the whole new list, so a reader's copy stays right
	// without asking again.
	if len(a.AddSteps) > 0 {
		all, err := appendJSON(s.Steps, a.AddSteps)
		if err != nil {
			return err
		}
		p.set["steps"] = all
		p.changes["steps"] = core.FieldChange{To: all}
	}
	if len(a.AddLinks) > 0 {
		all, err := appendJSON(s.Links, a.AddLinks)
		if err != nil {
			return err
		}
		p.set["links"] = all
		p.changes["links"] = core.FieldChange{To: all}
	}
	where := inWorkspace(c.ws)
	if s.TaskID != "" {
		var t core.Task
		ok, err := store.Find(c.ctx, c.tx, &t, store.Eq("id", s.TaskID))
		if err != nil {
			return err
		}
		if ok {
			where = inTask(t)
		}
	}
	return c.save(p, target{table: "agent_sessions", entity: "session", id: s.ID, place: where})
}
