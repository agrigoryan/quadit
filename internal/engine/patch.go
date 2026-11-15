// An update's changed fields, and saving or trashing one row with its event.

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
	p.changes[col] = core.FieldChange{From: nullIfEmpty(from), To: nullIfEmpty(to)}
}

// nullIfEmpty shows an unset reference as null in events.
func nullIfEmpty(v any) any {
	if s, ok := v.(string); ok && s == "" {
		return nil
	}
	return v
}

// setText applies an optional text argument. Null clears the field.
func (p *patch) setText(col string, o Opt[string], cur *string) {
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

func (p *patch) setNumber(col string, o Opt[int], cur *int) {
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

func (p *patch) setFlag(col string, o Opt[bool], cur *bool) {
	if !o.Set {
		return
	}
	p.put(col, *cur, o.V && !o.Null)
	*cur = o.V && !o.Null
}

// setStamp applies an optional on/off argument kept as the time it was
// turned on (archived_at, resolved_at): on stamps now, off clears it, and
// either leaves a field already so as it is.
func (p *patch) setStamp(col string, o Opt[bool], cur, now int64) {
	switch {
	case !o.Set:
	case o.V && cur == 0:
		p.put(col, int64(0), now)
	case !o.V && cur != 0:
		p.put(col, cur, int64(0))
	}
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
	p.setText(col, o, cur)
	return nil
}

// target names the row a save or a trash writes, and where its event
// belongs. extra is the event's data beside the id and the changes.
type target struct {
	table  string
	entity string // the kind of thing the row is, in events: "project"
	id     string
	place  place
	extra  core.EventData
}

// save writes the patch to one row and emits "<entity>.updated" with the
// changes, and makes the row the change's answer (c.ref), even when the
// patch is empty and nothing is written.
func (c *cx) save(p *patch, row target) error {
	c.ref = row.id
	if p.empty() {
		return nil // already as asked: nothing to write, no event
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"] = seq
	n, err := c.tx.Update(c.ctx, row.table, p.set, store.Eq("id", row.id))
	if err != nil {
		return alreadyInUse(err, row.entity, row.id)
	}
	if n != 1 {
		return notFound(row.entity, row.id)
	}
	data := row.extra
	data.ID, data.Changes = row.id, p.changes
	return c.emit(event{seq: seq, typ: row.entity + ".updated", entity: row.entity, entityID: row.id, place: row.place, data: data})
}

// trash moves a row to the trash and emits "<entity>.deleted", and makes
// the row the change's answer (c.ref).
func (c *cx) trash(row target) error {
	c.ref = row.id
	seq := c.tx.NextSeq()
	set := map[string]any{"deleted_at": c.at}
	if tb, ok := store.TableNamed(row.table); ok {
		if _, has := tb.Type.FieldByName("UpdatedSeq"); has {
			set["updated_seq"] = seq
		}
	}
	n, err := c.tx.Update(c.ctx, row.table, set, store.Eq("id", row.id), store.Live)
	if err != nil {
		return err
	}
	if n != 1 {
		return notFound(row.entity, row.id)
	}
	data := row.extra
	data.ID, data.Changes = row.id, map[string]core.FieldChange{"deleted_at": {From: nil, To: c.at}}
	return c.emit(event{seq: seq, typ: row.entity + ".deleted", entity: row.entity, entityID: row.id, place: row.place, data: data})
}

// emitDeleted emits "<entity>.deleted" for a row that was removed outright.
func (c *cx) emitDeleted(entity, rowID string, where place) error {
	return c.emit(event{seq: c.tx.NextSeq(), typ: entity + ".deleted", entity: entity, entityID: rowID, place: where, data: core.EventData{ID: rowID, Gone: true}})
}
