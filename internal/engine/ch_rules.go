// rule.create, rule.update and rule.delete.

package engine

import (
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// init registers rule.*.
func init() {
	register("rule.create", core.RoleAdmin, ruleCreate)
	register("rule.update", core.RoleAdmin, ruleUpdate)
	register("rule.delete", core.RoleAdmin, ruleDelete)
}

type ruleArgs struct {
	ID     string           `json:"id"`
	Name   string           `json:"name"`
	Active *bool            `json:"active"`
	Match  *core.RuleMatch  `json:"match"`
	Action *core.RuleAction `json:"action"`
}

var ruleActions = []string{core.RuleNotify, core.RuleWebhook, core.RuleAssign, core.RuleWaitOn}

// checkRuleMatch resolves the names in what a rule matches to ids.
func (c *cx) checkRuleMatch(m *core.RuleMatch) error {
	if m == nil {
		return nil
	}
	if m.ProjectID != "" {
		project, err := c.project(m.ProjectID)
		if err != nil {
			return err
		}
		m.ProjectID = project.ID
	}
	if m.ActorID != "" {
		mem, err := c.memberRef("match.actor_id", m.ActorID)
		if err != nil {
			return err
		}
		m.ActorID = mem.UserID
	}
	if m.ActorKind != "" && m.ActorKind != core.KindPerson && m.ActorKind != core.KindAgent {
		return oneOf("match.actor_kind", "kind", m.ActorKind, []string{core.KindPerson, core.KindAgent})
	}
	if m.ToCategory != "" && !core.ValidCategory(m.ToCategory) {
		return oneOf("match.to_category", "category", m.ToCategory, core.Categories)
	}
	return nil
}

// checkRule resolves the names in a rule to ids and refuses what cannot run.
func (c *cx) checkRule(m *core.RuleMatch, a *core.RuleAction) error {
	if a == nil || !slices.Contains(ruleActions, a.Kind) {
		kind := ""
		if a != nil {
			kind = a.Kind
		}
		return oneOf("action.kind", "action", kind, ruleActions)
	}
	if err := c.checkRuleMatch(m); err != nil {
		return err
	}
	if a.Kind == core.RuleWebhook {
		if _, err := loadLive[core.Webhook](c, "webhook", "action.webhook_id", a.WebhookID); err != nil {
			return err
		}
		return nil
	}
	mem, err := c.memberRef("action.user_id", a.UserID)
	if err != nil {
		return err
	}
	a.UserID = mem.UserID
	return nil
}

// ruleCreate adds a rule: an action the engine takes when a matching event
// happens.
func ruleCreate(c *cx, a ruleArgs) error {
	rid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a rule needs a name")
	}
	if a.Match == nil {
		a.Match = &core.RuleMatch{}
	}
	if err := c.checkRule(a.Match, a.Action); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	r := core.Rule{ID: rid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Active: a.Active == nil || *a.Active, Match: a.Match,
		Action: a.Action, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, r); err != nil {
		return alreadyInUse(err, "id", rid)
	}
	return c.created(seq, "rule", r.ID, inWorkspace(c.ws), r)
}

// ruleUpdate changes a rule.
func ruleUpdate(c *cx, a ruleArgs) error {
	r, err := loadLive[core.Rule](c, "rule", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if a.Name != "" {
		p.put("name", r.Name, strings.TrimSpace(a.Name))
	}
	if a.Active != nil {
		p.put("active", r.Active, *a.Active)
	}
	if a.Match != nil || a.Action != nil {
		m, act := r.Match, r.Action
		if a.Match != nil {
			m = a.Match
		}
		if a.Action != nil {
			act = a.Action
		}
		if err := c.checkRule(m, act); err != nil {
			return err
		}
		p.set["match_on"], p.set["action"] = m, act
		p.changes["match"], p.changes["action"] = core.FieldChange{To: m}, core.FieldChange{To: act}
	}
	return c.save(p, target{table: "rules", entity: "rule", id: r.ID, place: inWorkspace(c.ws)})
}

func ruleDelete(c *cx, a idArgs) error {
	r, err := loadLive[core.Rule](c, "rule", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash(target{table: "rules", entity: "rule", id: r.ID, place: inWorkspace(c.ws)})
}
