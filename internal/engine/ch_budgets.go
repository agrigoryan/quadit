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
		minutes += (end - s.StartedAt) / 60_000
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
		minutes += (end - sp.StartedAt) / 60_000
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
	near := func(used, limit int64) bool { return limit > 0 && used*10 >= limit*8 }
	once := func(userID, entityType, entityID, title string, since int64) error {
		if userID == "" {
			return nil
		}
		n, err := c.tx.Count(c.ctx, "notifications", store.Eq("user_id", userID), store.Eq("type", core.NoteBudget),
			store.Eq("entity_id", entityID), store.Eq("title", title), store.Gte("created_at", since))
		if err != nil || n > 0 {
			return err
		}
		return c.notify(userID, core.NoteBudget, core.Notification{EntityType: entityType, EntityID: entityID, Title: title, TaskID: s.TaskID})
	}
	var self core.User
	if err := c.tx.Get(c.ctx, &self, store.Eq("id", s.AgentID)); err != nil {
		return nil
	}
	if b := c.actor.Budget; b != nil && c.actor.UserID == s.AgentID {
		cost, minutes, err := c.e.Usage(c.ctx, c.tx, s.AgentID, weekStart(c.at))
		if err != nil {
			return err
		}
		if near(cost, b.CostMicros) || near(minutes, b.Minutes) {
			title := c.actor.Name + " has used 80% of its weekly budget"
			if b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes {
				title = c.actor.Name + " has used up its weekly budget"
			}
			if err := once(self.ResponsibleID, "member", s.AgentID, title, weekStart(c.at)); err != nil {
				return err
			}
		}
	}
	if s.TaskID == "" {
		return nil
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", s.TaskID)); err != nil || t.Budget == nil {
		return nil
	}
	cost, minutes, err := c.taskSpend(t.ID)
	if err != nil {
		return err
	}
	if near(cost, t.Budget.CostMicros) || near(minutes, t.Budget.Minutes) {
		who := t.AskedBy
		if who == "" {
			who = self.ResponsibleID
		}
		title := t.Key + " has used 80% of its budget"
		if cost >= t.Budget.CostMicros && t.Budget.CostMicros > 0 || minutes >= t.Budget.Minutes && t.Budget.Minutes > 0 {
			title = t.Key + " has used up its budget"
		}
		return once(who, "task", t.ID, title, 0)
	}
	return nil
}
