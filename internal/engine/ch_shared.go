package engine

import (
	"encoding/json"
	"reflect"

	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

const (
	// scanLimit is the most rows of one kind a change reads in one go.
	scanLimit = 5000
	// msPerMinute turns minutes into the Unix milliseconds times are kept in.
	msPerMinute = 60_000
	// defaultLeaseMinutes is how long a hold on a task or a resource lasts
	// without renewing, unless the one taking it says; maxLeaseMinutes the
	// longest it may.
	defaultLeaseMinutes = 30
	maxLeaseMinutes     = 24 * 60
	// defaultCycleDays is how long a cycle is when a project does not say.
	defaultCycleDays = 14
)

type idArgs struct {
	ID string `json:"id"`
}

// applyNested runs another change type inside this one, as the same actor.
func (c *cx) applyNested(changeType string, args any) error {
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	saved, ref, key := c.change, c.ref, c.key
	c.change = Change{ID: saved.ID, Type: changeType, Args: raw}
	err = handlers[changeType].fn(c)
	c.subRef = c.ref
	c.change, c.ref, c.key = saved, ref, key
	return err
}

// nextRank returns a rank after the last row matching conds.
func nextRank[T any](c *cx, conds ...store.Cond) (string, error) {
	var rows []T
	if err := c.tx.List(c.ctx, &rows, store.Q{Where: conds, Order: "-rank", Limit: 1}); err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return rank.ForNumber(1), nil
	}
	return rank.After(reflect.ValueOf(rows[0]).FieldByName("Rank").String()), nil
}

// rank applies an optional rank argument to a patch.
func (p *patch) rank(o Opt[string], cur *string) error {
	if !o.Set {
		return nil
	}
	if o.Null || !rank.Valid(o.V) {
		return invalid("rank", "%q is not a rank", o.V)
	}
	p.setText("rank", o, cur)
	return nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func without(list []string, v string) []string {
	out := make([]string, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func validSlug(s string) bool {
	if len(s) < 2 || len(s) > 40 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// checkHandle checks an @handle: what people type to mention someone.
func checkHandle(h string) error {
	if len(h) < 2 || len(h) > 32 {
		return invalid("handle", "a handle is 2 to 32 characters")
	}
	for _, r := range h {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return invalid("handle", "a handle uses lower-case letters, digits, - and _ only: %q", h)
		}
	}
	return nil
}
