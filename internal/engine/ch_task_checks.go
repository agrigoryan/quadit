// The checks on a task change: a stale base, a parent loop, hand-offs.

package engine

import (
	"sort"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// staleError is the refusal of an update based on an old version (base): it
// says what changed since, so the caller can decide without reading the
// task again.
func (c *cx) staleError(t core.Task, base int64) error {
	evs, err := c.tx.Events(c.ctx, store.EventFilter{After: base, ScopeType: "task", ScopeID: t.ID, Types: []string{"task.updated"}, Limit: 20})
	if err != nil {
		return err
	}
	fields := map[string]bool{}
	for _, ev := range evs {
		d, _ := ev.Payload() // data that does not read names no field
		for f := range d.Changes {
			fields[f] = true
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
	chain, err := c.agentChain(evs)
	if err != nil {
		return err
	}
	// A hand-off counts against a budget: the agent's for the week, and the
	// task's own.
	if err := c.checkWeeklyHandoffs(); err != nil {
		return err
	}
	if err := c.checkTaskHandoffs(t, evs); err != nil {
		return err
	}
	if chain >= maxHandoffs {
		return &Error{Code: CodeConflict, Message: "this task has been handed from agent to agent " + itoa(chain) +
			" times in a row; hand it to a person (waiting_on or assignee) so they can decide where it goes"}
	}
	return nil
}

// isHandoff reports whether a task event changed who the task is assigned to.
func isHandoff(ev core.Event) bool {
	d, _ := ev.Payload() // data that does not read hands the task to nobody
	return d.Sets("assignee_id")
}

// byAgent reports whether an event was written by an agent that is still a
// member.
func (c *cx) byAgent(ev core.Event) (bool, error) {
	var actor core.Member
	ok, err := store.Find(c.ctx, c.tx, &actor, store.Eq("user_id", ev.ActorID))
	return ok && actor.Kind == core.KindAgent, err
}

// agentChain counts the hand-offs between agents since a person last
// assigned the task, newest first.
func (c *cx) agentChain(evs []core.Event) (int, error) {
	chain := 0
	for _, ev := range evs {
		if !isHandoff(ev) {
			continue
		}
		agent, err := c.byAgent(ev)
		if err != nil {
			return 0, err
		}
		if !agent {
			break // a person assigned it: the chain starts over
		}
		chain++
	}
	return chain, nil
}

// checkWeeklyHandoffs refuses a hand-off beyond the acting agent's weekly
// budget of them.
func (c *cx) checkWeeklyHandoffs() error {
	b := c.actor.Budget
	if b == nil || b.Handoffs <= 0 {
		return nil
	}
	mine, err := c.tx.Events(c.ctx, store.EventFilter{ActorID: c.actor.UserID, Types: []string{"task.updated"}, Desc: true, Limit: 2000})
	if err != nil {
		return err
	}
	var n int64
	for _, ev := range mine {
		if ev.At < weekStart(c.at) {
			break
		}
		if isHandoff(ev) {
			n++
		}
	}
	if n >= b.Handoffs {
		return &Error{Code: CodeBudget, Message: "this agent has passed work on " + itoa(int(n)) + " times this week, which is its limit; hand the task to a person"}
	}
	return nil
}

// checkTaskHandoffs refuses a hand-off beyond the task's own budget of
// hand-offs between agents.
func (c *cx) checkTaskHandoffs(t core.Task, evs []core.Event) error {
	b := t.Budget
	if b == nil || b.Handoffs <= 0 {
		return nil
	}
	var n int64
	for _, ev := range evs {
		if !isHandoff(ev) {
			continue
		}
		agent, err := c.byAgent(ev)
		if err != nil {
			return err
		}
		if agent {
			n++
		}
	}
	if n >= b.Handoffs {
		return &Error{Code: CodeBudget, Message: t.Key + " has been passed between agents " + itoa(int(n)) + " times, which is its limit; hand it to a person"}
	}
	return nil
}
