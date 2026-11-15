package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// Actor is who sends a change, and how the credential they used narrows
// what their role allows.
type Actor struct {
	UserID   string
	ReadOnly bool
	Projects []string // project ids the credential is limited to; nil = no limit
}

// intersectProjects returns the project ids allowed by both lists; an empty list
// allows everything.
func intersectProjects(a, b []string) []string {
	if len(a) == 0 {
		return b
	}
	var out []string
	for _, x := range b {
		if contains(a, x) {
			out = append(out, x)
		}
	}
	if len(out) == 0 {
		out = []string{"none"} // both lists exist but share nothing
	}
	return out
}

// checkAsker holds an agent, on a task a person gave to an agent, to that
// person's access: the work runs as the one who asked for it, not with the
// agent's wider access. It is checked where a write to the task is recorded,
// so it covers every kind of change to the task.
func (c *cx) checkAsker(taskID string) error {
	if c.system || c.actor.Kind != core.KindAgent || c.askerOK == nil || c.askerOK[taskID] {
		return nil
	}
	var t core.Task
	if ok, err := found(c.tx.Get(c.ctx, &t, store.Eq("id", taskID))); !ok {
		return err // nil when the task is gone: there is nothing to hold to
	}
	c.askerOK[taskID] = true
	if t.AskedBy == "" || t.AskedBy == c.actor.UserID {
		return nil
	}
	var m core.Member
	ok, err := found(c.tx.Get(c.ctx, &m, store.Eq("user_id", t.AskedBy)))
	if err != nil {
		return err
	}
	if !ok || m.SuspendedAt != 0 {
		return forbidden("%s was given to an agent by someone who no longer has access here; a person has to assign it again", t.Key)
	}
	min := handlers[c.change.Type].min
	if !m.Role.AtLeast(min) {
		return forbidden("%s needs the %s role; @%s, who asked for the work on %s, is a %s", c.change.Type, min, m.Handle, t.Key, m.Role)
	}
	if m.Scope != nil {
		if m.Scope.ReadOnly {
			return forbidden("@%s, who asked for the work on %s, may only read", m.Handle, t.Key)
		}
		if len(m.Scope.Projects) > 0 {
			if !contains(m.Scope.Projects, t.ProjectID) {
				return forbidden("@%s, who asked for the work on %s, has no access to its project", m.Handle, t.Key)
			}
			c.scope.Projects = intersectProjects(c.scope.Projects, m.Scope.Projects)
		}
	}
	return nil
}

// askedBy works out who a task is worked for once its assignee is set: the
// person who gave it to an agent. An agent passing it on keeps the person it
// came from; a task a person holds is worked for nobody else.
func (c *cx) askedBy(t core.Task) (string, error) {
	if t.AssigneeID == "" {
		return "", nil
	}
	to, err := c.memberRef("assignee", t.AssigneeID)
	if err != nil || to.Kind != core.KindAgent {
		return "", err
	}
	switch {
	case c.asker != "":
		return c.asker, nil
	case !c.system && c.actor.Kind != core.KindAgent:
		return c.actor.UserID, nil
	}
	return t.AskedBy, nil
}
