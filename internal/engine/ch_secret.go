// secret.set, secret.delete, and secret.send: a request made with a secret
// that can change something outside.

package engine

import (
	"regexp"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("secret.set", core.RoleAdmin, secretSet)
	register("secret.delete", core.RoleAdmin, secretDelete)
	register("secret.send", core.RoleMember, secretSend)
}

type secretArgs struct {
	ID string `json:"id"`
	// Name is how the secret is asked for, e.g. GITHUB_TOKEN. Setting a name
	// that exists changes that secret.
	Name        string      `json:"name" quadit:"required,handler"`
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

// secretSet makes a secret or changes the one with that name.
func secretSet(c *cx, a secretArgs) error {
	if !secretName.MatchString(a.Name) {
		return invalid("name", "a secret's name is letters, digits and _, starting with a letter (like GITHUB_TOKEN)")
	}
	hosts, err := secretHosts(a.Hosts.V)
	if err != nil {
		return err
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
	ok, err := store.Find(c.ctx, c.tx, &cur, store.Eq("name", a.Name), store.Live)
	if err != nil {
		return err
	}
	if !ok {
		return c.secretNew(a, hosts, agents)
	}
	return c.secretChange(cur, a, hosts, agents)
}

// secretHosts reads the hosts a secret may be sent to, in one spelling.
func secretHosts(given []string) ([]string, error) {
	var hosts []string
	for _, h := range given {
		h = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(h), "https://"), "/"))
		if !secretHost.MatchString(h) {
			return nil, invalid("hosts", "%q is not a host; write api.example.com or *.example.com", h)
		}
		hosts = append(hosts, h)
	}
	return hosts, nil
}

// secretNew keeps a secret under a name not used yet.
func (c *cx) secretNew(a secretArgs, hosts, agents []string) error {
	if a.Value.V == "" {
		return invalid("value", "a new secret needs its value")
	}
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	sealed, err := c.e.sealSecret(a.Value.V)
	if err != nil {
		return err
	}
	s := core.Secret{ID: sid, WorkspaceID: c.ws, Name: a.Name, Description: a.Description.V, Value: sealed, Hosts: hosts, Agents: agents,
		Env: a.Env.V, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	seq := c.tx.NextSeq()
	s.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, s); err != nil {
		return alreadyInUse(err, "id", sid)
	}
	return c.created(seq, "secret", s.ID, inWorkspace(c.ws), s)
}

// secretChange changes what is given of the secret already kept under the
// name.
func (c *cx) secretChange(cur core.Secret, a secretArgs, hosts, agents []string) error {
	p := newPatch()
	p.setText("description", a.Description, &cur.Description)
	if a.Hosts.Set {
		p.put("hosts", cur.Hosts, hosts)
	}
	if a.Agents.Set {
		p.put("agents", cur.Agents, agents)
	}
	p.setFlag("env", a.Env, &cur.Env)
	if a.Value.Set && a.Value.V != "" {
		sealed, err := c.e.sealSecret(a.Value.V)
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
	return c.save(p, target{table: "secrets", entity: "secret", id: cur.ID, place: inWorkspace(c.ws)})
}

func secretDelete(c *cx, a idArgs) error {
	var s core.Secret
	there, err := store.Find(c.ctx, c.tx, &s, store.Eq("id", a.ID), store.Live)
	if err != nil {
		return err
	}
	if !there {
		if err := c.tx.Get(c.ctx, &s, store.Eq("name", a.ID), store.Live); err != nil {
			return missing(err, "secret", a.ID)
		}
	}
	// The value is wiped at once; the row stays in the trash for the record.
	if _, err := c.tx.Update(c.ctx, "secrets", map[string]any{"value": ""}, store.Eq("id", s.ID)); err != nil {
		return err
	}
	return c.trash(target{table: "secrets", entity: "secret", id: s.ID, place: inWorkspace(c.ws), extra: core.EventData{Name: s.Name}})
}

// secretSendArgs are the whole request as the caller writes it, with
// {{secret}} where the value goes and never the value: an approval of
// secret.send covers that request and no other, so a request that differs
// in anything (another body, a header that changes what the service does)
// needs its own.
type secretSendArgs struct {
	// Name is the secret's name.
	Name    string            `json:"name" quadit:"required,handler"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	// Body is the body as text; BodyBase64 the body when it is not text.
	Body       string `json:"body,omitempty"`
	BodyBase64 string `json:"body_base64,omitempty"`
}

// secretSend stands for a request the server sends with a secret that can
// change something at the far end: any method but GET, HEAD and OPTIONS.
// The server makes the request once this change is allowed, so it is held
// to what every change is (a member who may only read, an approval for an
// agent that must ask before it reaches outside). It writes nothing but
// its own record.
func secretSend(c *cx, a secretSendArgs) error {
	var sec core.Secret
	if err := c.tx.Get(c.ctx, &sec, store.Eq("name", a.Name), store.Live); err != nil {
		return missing(err, "secret", a.Name)
	}
	if !MayUseSecret(sec, c.actor) {
		return forbidden("the secret %s is not for you; an admin decides who may use it", sec.Name)
	}
	c.ref = sec.ID
	return nil
}

// MayUseSecret reports whether a member is among those a secret is for:
// every member, unless the secret names the agents that may use it.
func MayUseSecret(sec core.Secret, m core.Member) bool {
	return len(sec.Agents) == 0 || m.Kind != core.KindAgent || slices.Contains(sec.Agents, m.UserID)
}
