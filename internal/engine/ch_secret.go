package engine

import (
	"errors"
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("secret.set", core.RoleAdmin, secretSet)
	register("secret.delete", core.RoleAdmin, secretDelete)
}

type secretArgs struct {
	ID string `json:"id"`
	// Name is how the secret is asked for, e.g. GITHUB_TOKEN. Setting a name
	// that exists changes that secret.
	Name        string      `json:"name"`
	Description Opt[string] `json:"description"`
	// Value is the secret itself. It is stored encrypted and is never
	// returned by anything; leave it out to keep the one there.
	Value Opt[string] `json:"value"`
	// Hosts the secret may be sent to: "api.example.com", "*.example.com".
	Hosts Opt[[]string] `json:"hosts"`
	// Agents that may use it, by @handle; empty means every member.
	Agents Opt[[]string] `json:"agents"`
	// Env lets a companion with a token made for secrets receive the value,
	// for the environment of the command it runs.
	Env Opt[bool] `json:"env"`
}

var (
	secretName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	secretHost = regexp.MustCompile(`^(http://)?(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$`)
)

// Seal encrypts a secret before it is stored. The server sets it.
var Seal = func(plain string) (string, error) { return plain, nil }

// secretSet makes a secret or changes the one with that name.
func secretSet(c *cx, a secretArgs) error {
	if !secretName.MatchString(a.Name) {
		return invalid("name", "a secret's name is letters, digits and _, starting with a letter (like GITHUB_TOKEN)")
	}
	var hosts []string
	for _, h := range a.Hosts.V {
		h = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(h), "https://"), "/"))
		if !secretHost.MatchString(h) {
			return invalid("hosts", "%q is not a host; write api.example.com or *.example.com", h)
		}
		hosts = append(hosts, h)
	}
	var agents []string
	for _, ref := range a.Agents.V {
		m, err := c.memberRef("agents", ref)
		if err != nil {
			return err
		}
		agents = append(agents, m.UserID)
	}
	var cur core.Secret
	err := c.tx.Get(c.ctx, &cur, store.Eq("name", a.Name), store.Live)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err != nil {
		// New.
		if a.Value.V == "" {
			return invalid("value", "a new secret needs its value")
		}
		sid, err := newID("id", a.ID)
		if err != nil {
			return err
		}
		sealed, err := Seal(a.Value.V)
		if err != nil {
			return err
		}
		s := core.Secret{ID: sid, WorkspaceID: c.ws, Name: a.Name, Description: a.Description.V, Value: sealed, Hosts: hosts, Agents: agents,
			Env: a.Env.V, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
		seq := c.tx.NextSeq()
		s.UpdatedSeq = seq
		if err := c.tx.Insert(c.ctx, s); err != nil {
			return taken(err, "id", sid)
		}
		return c.created(seq, "secret", s.ID, "workspace", c.ws, "", s)
	}
	p := newPatch()
	p.str("description", a.Description, &cur.Description)
	if a.Hosts.Set {
		p.put("hosts", cur.Hosts, hosts)
	}
	if a.Agents.Set {
		p.put("agents", cur.Agents, agents)
	}
	p.flag("env", a.Env, &cur.Env)
	if a.Value.Set && a.Value.V != "" {
		sealed, err := Seal(a.Value.V)
		if err != nil {
			return err
		}
		p.set["value"] = sealed
		// The event says that the value changed, never what it is.
		p.changes["value_changed_at"] = core.FieldChange{To: c.at}
	}
	if !p.empty() {
		p.set["updated_at"] = c.at
		p.changes["updated_at"] = core.FieldChange{From: cur.UpdatedAt, To: c.at}
	}
	return c.save(p, "secrets", "secret", cur.ID, "workspace", c.ws, "", nil)
}

func secretDelete(c *cx, a idArgs) error {
	var s core.Secret
	if err := c.tx.Get(c.ctx, &s, store.Eq("id", a.ID), store.Live); err != nil {
		if err := c.tx.Get(c.ctx, &s, store.Eq("name", a.ID), store.Live); err != nil {
			return missing(err, "secret", a.ID)
		}
	}
	// The value is wiped at once; the row stays in the trash for the record.
	if _, err := c.tx.Update(c.ctx, "secrets", map[string]any{"value": ""}, store.Eq("id", s.ID)); err != nil {
		return err
	}
	return c.trash("secrets", "secret", s.ID, "workspace", c.ws, "", map[string]any{"name": s.Name})
}
