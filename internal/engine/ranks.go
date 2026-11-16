// A row's place in its list: the rank a new row at the end takes, and a
// rank a change gives.

package engine

import (
	"reflect"

	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

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
