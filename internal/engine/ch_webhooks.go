package engine

import (
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

func init() {
	register("webhook.create", core.RoleAdmin, webhookCreate)
	register("webhook.update", core.RoleAdmin, webhookUpdate)
	register("webhook.delete", core.RoleAdmin, webhookDelete)
}

type webhookCreateArgs struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	URL        string   `json:"url"`
	Secret     string   `json:"secret"`      // signs each delivery; made by the caller so it can be shown once
	EventTypes []string `json:"event_types"` // empty = every event
	Project    string   `json:"project"`
	// For, when set, sends only what lands in this member's inbox: the
	// push way to wake an agent.
	For    string `json:"for"`
	Active *bool  `json:"active"`
}

func checkURL(field, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return invalid(field, "%q is not an http or https URL", raw)
	}
	return nil
}

func webhookCreate(c *cx, a webhookCreateArgs) error {
	wid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if err := checkURL("url", a.URL); err != nil {
		return err
	}
	w := core.Webhook{ID: wid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), URL: a.URL, Secret: a.Secret, EventTypes: a.EventTypes,
		Active: a.Active == nil || *a.Active, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if w.Name == "" {
		u, _ := url.Parse(a.URL)
		w.Name = u.Host
	}
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		w.ProjectID = p.ID
	}
	if w.UserID, err = c.optMember("for", a.For); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	w.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, w); err != nil {
		return alreadyInUse(err, "id", wid)
	}
	return c.created(seq, "webhook", w.ID, "workspace", c.ws, "", w)
}

type webhookUpdateArgs struct {
	ID         string        `json:"id"`
	Name       Opt[string]   `json:"name"`
	URL        Opt[string]   `json:"url"`
	Secret     Opt[string]   `json:"secret"`
	EventTypes Opt[[]string] `json:"event_types"`
	Project    Opt[string]   `json:"project"`
	For        Opt[string]   `json:"for"`
	Active     Opt[bool]     `json:"active"`
}

func webhookUpdate(c *cx, a webhookUpdateArgs) error {
	w, err := loadLive[core.Webhook](c, "webhook", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &w.Name); err != nil {
		return err
	}
	if a.URL.Set {
		if err := checkURL("url", a.URL.V); err != nil {
			return err
		}
		p.setText("url", a.URL, &w.URL)
	}
	if a.Secret.Set && a.Secret.V != w.Secret {
		p.set["secret"] = a.Secret.V
		p.changes["secret"] = core.FieldChange{To: "(changed)"}
	}
	if a.EventTypes.Set {
		p.put("event_types", w.EventTypes, a.EventTypes.V)
	}
	if a.Project.Set {
		pid := ""
		if !a.Project.Null && a.Project.V != "" {
			pr, err := c.project(a.Project.V)
			if err != nil {
				return err
			}
			pid = pr.ID
		}
		p.put("project_id", w.ProjectID, pid)
	}
	if a.For.Set {
		uid := ""
		if !a.For.Null {
			if uid, err = c.optMember("for", a.For.V); err != nil {
				return err
			}
		}
		p.put("user_id", w.UserID, uid)
	}
	if a.Active.Set && a.Active.V != w.Active {
		p.put("active", w.Active, a.Active.V)
		if a.Active.V {
			p.set["failures"] = 0 // turning it back on gives it a clean slate
		}
	}
	return c.save(p, "webhooks", "webhook", w.ID, "workspace", c.ws, "", nil)
}

func webhookDelete(c *cx, a idArgs) error {
	w, err := loadLive[core.Webhook](c, "webhook", "id", a.ID)
	if err != nil {
		return err
	}
	return c.trash("webhooks", "webhook", w.ID, "workspace", c.ws, "", nil)
}
