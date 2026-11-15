package engine

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// stale refuses an update based on an old version and says what changed
// since, so the caller can decide without reading the task again.
func (c *cx) stale(t core.Task, base int64) error {
	evs, err := c.tx.Events(c.ctx, store.EventFilter{After: base, ScopeType: "task", ScopeID: t.ID, Types: []string{"task.updated"}, Limit: 20})
	if err != nil {
		return err
	}
	fields := map[string]bool{}
	for _, ev := range evs {
		var d struct {
			Changes map[string]json.RawMessage `json:"changes"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			for f := range d.Changes {
				fields[f] = true
			}
		}
	}
	var changed []string
	for f := range fields {
		changed = append(changed, f)
	}
	sort.Strings(changed)
	return &Error{Code: CodeStale, Allowed: changed, Message: "task " + t.Key + " changed since seq " + itoa(int(base)) +
		" (it is now at " + itoa(int(t.UpdatedSeq)) + "; changed fields are listed); read it again, or resend without base_seq to overwrite"}
}

// checkParent refuses a parent that would make a loop.
func (c *cx) checkParent(t core.Task, parentID string) error {
	cur := parentID
	for depth := 0; cur != ""; depth++ {
		if cur == t.ID {
			return invalid("parent", "a task cannot be its own ancestor")
		}
		if depth > 50 {
			return invalid("parent", "sub-tasks are nested too deep")
		}
		var p core.Task
		if err := c.tx.Get(c.ctx, &p, store.Eq("id", cur)); err != nil {
			return missing(err, "parent task", cur)
		}
		cur = p.ParentID
	}
	return nil
}

const maxHandoffs = 5

// checkHandoff stops a task from bouncing between agents with no person in
// between: after a few agent-to-agent hand-offs in a row, a person has to
// step in.
func (c *cx) checkHandoff(t core.Task) error {
	to, err := c.memberRef("assignee", t.AssigneeID)
	if err != nil || to.Kind != core.KindAgent {
		return err
	}
	evs, err := c.tx.Events(c.ctx, store.EventFilter{ScopeType: "task", ScopeID: t.ID, Types: []string{"task.updated", "task.created"}, Desc: true, Limit: 60})
	if err != nil {
		return err
	}
	chain := 0
	for _, ev := range evs {
		if !strings.Contains(string(ev.Data), `"assignee_id"`) {
			continue
		}
		var actor core.Member
		if err := c.tx.Get(c.ctx, &actor, store.Eq("user_id", ev.ActorID)); err != nil || actor.Kind != core.KindAgent {
			break // a person assigned it: the chain starts over
		}
		chain++
	}
	// A hand-off counts against a budget: the agent's for the week, and the
	// task's own.
	if b := c.actor.Budget; b != nil && b.Handoffs > 0 {
		mine, err := c.tx.Events(c.ctx, store.EventFilter{ActorID: c.actor.UserID, Types: []string{"task.updated"}, Desc: true, Limit: 2000})
		if err != nil {
			return err
		}
		var n int64
		for _, ev := range mine {
			if ev.At < weekStart(c.at) {
				break
			}
			if strings.Contains(string(ev.Data), `"assignee_id"`) {
				n++
			}
		}
		if n >= b.Handoffs {
			return &Error{Code: CodeBudget, Message: "this agent has passed work on " + itoa(int(n)) + " times this week, which is its limit; hand the task to a person"}
		}
	}
	if b := t.Budget; b != nil && b.Handoffs > 0 {
		var n int64
		for _, ev := range evs {
			var actor core.Member
			if strings.Contains(string(ev.Data), `"assignee_id"`) && c.tx.Get(c.ctx, &actor, store.Eq("user_id", ev.ActorID)) == nil && actor.Kind == core.KindAgent {
				n++
			}
		}
		if n >= b.Handoffs {
			return &Error{Code: CodeBudget, Message: t.Key + " has been passed between agents " + itoa(int(n)) + " times, which is its limit; hand it to a person"}
		}
	}
	if chain >= maxHandoffs {
		return &Error{Code: CodeConflict, Message: "this task has been handed from agent to agent " + itoa(chain) +
			" times in a row; hand it to a person (waiting_on or assignee) so they can decide where it goes"}
	}
	return nil
}
