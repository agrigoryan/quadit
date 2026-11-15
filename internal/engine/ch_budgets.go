package engine

import (
	"context"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// Usage sums what an agent's recorded sessions cost since a time.
func (e *Engine) Usage(ctx context.Context, db store.DB, agentID string, since int64) (costMicros, minutes int64, err error) {
	var ss []core.AgentSession
	if err := db.List(ctx, &ss, store.Where(store.Eq("agent_id", agentID), store.Gte("started_at", since))); err != nil {
		return 0, 0, err
	}
	now := e.now().UnixMilli()
	for _, s := range ss {
		costMicros += s.CostMicros
		end := s.EndedAt
		if end == 0 {
			end = now
		}
		minutes += (end - s.StartedAt) / msPerMinute
	}
	return costMicros, minutes, nil
}

// weekStart returns the start of the week (Monday, UTC) containing at.
func weekStart(at int64) int64 {
	t := time.UnixMilli(at).UTC()
	wd := (int(t.Weekday()) + 6) % 7
	return time.Date(t.Year(), t.Month(), t.Day()-wd, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// checkBudget refuses new work to an agent that has used up its week.
func (c *cx) checkBudget() error {
	b := c.actor.Budget
	if b == nil || c.system {
		return nil
	}
	cost, minutes, err := c.e.Usage(c.ctx, c.tx, c.actor.UserID, weekStart(c.at))
	if err != nil {
		return err
	}
	if b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes {
		return &Error{Code: CodeBudget, Message: "this agent has used its budget for the week; finish or hand over what is open, and ask the person responsible to raise the limit"}
	}
	return nil
}

// taskSpend adds up what agents have spent on a task: cost, and minutes of
// work, the running sessions included.
func (c *cx) taskSpend(taskID string) (cost, minutes int64, err error) {
	var spent []core.AgentSession
	if err := c.tx.List(c.ctx, &spent, store.Where(store.Eq("task_id", taskID))); err != nil {
		return 0, 0, err
	}
	for _, sp := range spent {
		cost += sp.CostMicros
		end := sp.EndedAt
		if end == 0 {
			end = c.at
		}
		minutes += (end - sp.StartedAt) / msPerMinute
	}
	return cost, minutes, nil
}

// checkTaskBudget refuses new work on a task whose own budget is used up.
// Saying so on the task, and handing it back, stay possible: a clean stop.
func (c *cx) checkTaskBudget(t core.Task) error {
	b := t.Budget
	if b == nil || c.system || c.actor.Kind != core.KindAgent {
		return nil
	}
	cost, minutes, err := c.taskSpend(t.ID)
	if err != nil {
		return err
	}
	if b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes {
		return &Error{Code: CodeBudget, Message: "the budget set for " + t.Key + " is used up; say so on the task and ask for more before going on"}
	}
	return nil
}

// budgetWarnings tells the people concerned, once, when an agent's week or
// a task's own budget is four-fifths used: in cost or in time.
func (c *cx) budgetWarnings(s core.AgentSession) error {
	var self core.User
	if ok, err := found(c.tx.Get(c.ctx, &self, store.Eq("id", s.AgentID))); !ok {
		return err // the agent's account is gone: nobody to warn
	}
	if err := c.weekWarning(s, self); err != nil {
		return err
	}
	return c.taskBudgetWarning(s, self)
}

// nearLimit reports whether used is four-fifths of a limit or more; a limit
// of 0 is none.
func nearLimit(used, limit int64) bool { return limit > 0 && used*10 >= limit*8 }

// usedUp reports whether cost or time has reached its limit.
func usedUp(cost, minutes int64, b *core.Budget) bool {
	return b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes
}

// weekWarning warns the person responsible for an agent that is near or
// at its weekly budget.
func (c *cx) weekWarning(s core.AgentSession, self core.User) error {
	b := c.actor.Budget
	if b == nil || c.actor.UserID != s.AgentID {
		return nil
	}
	cost, minutes, err := c.e.Usage(c.ctx, c.tx, s.AgentID, weekStart(c.at))
	if err != nil {
		return err
	}
	if !nearLimit(cost, b.CostMicros) && !nearLimit(minutes, b.Minutes) {
		return nil
	}
	title := c.actor.Name + " has used 80% of its weekly budget"
	if usedUp(cost, minutes, b) {
		title = c.actor.Name + " has used up its weekly budget"
	}
	return c.warnOnce(self.ResponsibleID, core.Notification{EntityType: "member", EntityID: s.AgentID, Title: title, TaskID: s.TaskID}, weekStart(c.at))
}

// taskBudgetWarning warns the one who asked for a task, or else the person
// responsible for the agent, that the task is near or at its own budget.
func (c *cx) taskBudgetWarning(s core.AgentSession, self core.User) error {
	if s.TaskID == "" {
		return nil
	}
	var t core.Task
	if ok, err := found(c.tx.Get(c.ctx, &t, store.Eq("id", s.TaskID))); !ok || t.Budget == nil {
		return err
	}
	cost, minutes, err := c.taskSpend(t.ID)
	if err != nil {
		return err
	}
	if !nearLimit(cost, t.Budget.CostMicros) && !nearLimit(minutes, t.Budget.Minutes) {
		return nil
	}
	who := t.AskedBy
	if who == "" {
		who = self.ResponsibleID
	}
	title := t.Key + " has used 80% of its budget"
	if usedUp(cost, minutes, t.Budget) {
		title = t.Key + " has used up its budget"
	}
	return c.warnOnce(who, core.Notification{EntityType: "task", EntityID: t.ID, Title: title, TaskID: s.TaskID}, 0)
}

// warnOnce puts a budget warning in a member's inbox unless the same one
// is there already since the given time.
func (c *cx) warnOnce(userID string, n core.Notification, since int64) error {
	if userID == "" {
		return nil
	}
	had, err := c.tx.Count(c.ctx, "notifications", store.Eq("user_id", userID), store.Eq("type", core.NoteBudget),
		store.Eq("entity_id", n.EntityID), store.Eq("title", n.Title), store.Gte("created_at", since))
	if err != nil || had > 0 {
		return err
	}
	return c.notify(userID, core.NoteBudget, n)
}
