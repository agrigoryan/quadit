package engine

import (
	"reflect"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// patch collects the columns an update writes and, for the event, each
// field's old and new value. A field already at the value asked for is left
// out, so an update that changes nothing writes nothing.
type patch struct {
	set     map[string]any
	changes map[string]core.FieldChange
}

func newPatch() *patch {
	return &patch{set: map[string]any{}, changes: map[string]core.FieldChange{}}
}

func (p *patch) empty() bool { return len(p.changes) == 0 }

// put records one change when to differs from from.
func (p *patch) put(col string, from, to any) {
	if reflect.DeepEqual(from, to) {
		return
	}
	p.set[col] = to
	p.changes[col] = core.FieldChange{From: zeroNil(from), To: zeroNil(to)}
}

// zeroNil shows an unset reference as null in events.
func zeroNil(v any) any {
	if s, ok := v.(string); ok && s == "" {
		return nil
	}
	return v
}

// str applies an optional text argument. Null clears the field.
func (p *patch) str(col string, o Opt[string], cur *string) {
	if !o.Set {
		return
	}
	v := o.V
	if o.Null {
		v = ""
	}
	p.put(col, *cur, v)
	*cur = v
}

func (p *patch) num(col string, o Opt[int], cur *int) {
	if !o.Set {
		return
	}
	v := o.V
	if o.Null {
		v = 0
	}
	p.put(col, *cur, v)
	*cur = v
}

func (p *patch) flag(col string, o Opt[bool], cur *bool) {
	if !o.Set {
		return
	}
	p.put(col, *cur, o.V && !o.Null)
	*cur = o.V && !o.Null
}

// name applies an optional text argument that may not be empty.
func (p *patch) name(col string, o Opt[string], cur *string) error {
	if !o.Set {
		return nil
	}
	v := strings.TrimSpace(o.V)
	if o.Null || v == "" {
		return invalid(col, "%s cannot be empty", col)
	}
	p.put(col, *cur, v)
	*cur = v
	return nil
}

// date applies an optional YYYY-MM-DD argument.
func (p *patch) date(col string, o Opt[string], cur *string) error {
	if o.Set && !o.Null {
		if err := checkDate(col, o.V); err != nil {
			return err
		}
	}
	p.str(col, o, cur)
	return nil
}

// save writes the patch to one row and emits "<entity>.updated" with the
// changes. extra is added to the event's data.
func (c *cx) save(p *patch, table, entity, rowID, scopeType, scopeID, projectID string, extra map[string]any) error {
	c.ref = rowID
	if p.empty() {
		return nil // already as asked: nothing to write, no event
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"] = seq
	n, err := c.tx.Update(c.ctx, table, p.set, store.Eq("id", rowID))
	if err != nil {
		return taken(err, entity, rowID)
	}
	if n != 1 {
		return notFound(entity, rowID)
	}
	data := map[string]any{"id": rowID, "changes": p.changes}
	for k, v := range extra {
		data[k] = v
	}
	return c.emit(seq, entity+".updated", entity, rowID, scopeType, scopeID, projectID, data)
}

// trash moves a row to the trash and emits "<entity>.deleted".
func (c *cx) trash(table, entity, rowID, scopeType, scopeID, projectID string, extra map[string]any) error {
	c.ref = rowID
	seq := c.tx.NextSeq()
	set := map[string]any{"deleted_at": c.at}
	if tb, ok := store.TableNamed(table); ok {
		if _, has := tb.Type.FieldByName("UpdatedSeq"); has {
			set["updated_seq"] = seq
		}
	}
	n, err := c.tx.Update(c.ctx, table, set, store.Eq("id", rowID), store.Live)
	if err != nil {
		return err
	}
	if n != 1 {
		return notFound(entity, rowID)
	}
	data := map[string]any{"id": rowID, "changes": map[string]core.FieldChange{"deleted_at": {From: nil, To: c.at}}}
	for k, v := range extra {
		data[k] = v
	}
	return c.emit(seq, entity+".deleted", entity, rowID, scopeType, scopeID, projectID, data)
}

// gone emits "<entity>.deleted" for a row that was removed outright.
func (c *cx) gone(entity, rowID, scopeType, scopeID, projectID string) error {
	return c.emit(c.tx.NextSeq(), entity+".deleted", entity, rowID, scopeType, scopeID, projectID, map[string]any{"id": rowID, "gone": true})
}
