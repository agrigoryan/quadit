// Who may see a page, and the pages under it.
//
// A private page is its owner's and those it is shared with (owner_id and
// shared_with on its row); the pages under it are private the same way.
// That is kept true when it is written, not looked up when it is read:
// CanSeeDoc reads one row. A page placed under a private page takes its
// readers (underPrivate): one made there (placeDoc), unless it is made
// private itself and so given its own (docReaders); one moved there
// (docUpdate); one brought back there from a backup (RestoreFromBackup).
// Changing who sees a page passes the change down to the pages under it
// that had its readers (passReadersDown). A page moved out of one stays as
// private as it was: nobody is shown a page because it moved.

package engine

import (
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// underPrivate gives a page placed under parent the parent's readers when
// the parent is private: a page under a private page is private the same
// way. A page that is someone's own private page keeps its readers, unless
// it is the one placing it (by) who owns it; only its owner changes who sees
// a private page. It reports whether the page's readers changed hands.
func underPrivate(d *core.Doc, parent core.Doc, by string) bool {
	if parent.OwnerID == "" || d.OwnerID != "" && d.OwnerID != by {
		return false
	}
	d.OwnerID, d.SharedWith = parent.OwnerID, parent.SharedWith
	return true
}

// readersOf is who may see a page: nil for everyone, else its owner and
// those it is shared with.
func readersOf(d core.Doc) []string {
	if d.OwnerID == "" {
		return nil
	}
	return append([]string{d.OwnerID}, d.SharedWith...)
}

// sameReaders reports whether the same members may see two pages. The list
// a page that is everyone's keeps from when it was shared does not count.
func sameReaders(a, b core.Doc) bool {
	if a.OwnerID != b.OwnerID {
		return false
	}
	return a.OwnerID == "" || slices.Equal(slices.Sorted(slices.Values(a.SharedWith)), slices.Sorted(slices.Values(b.SharedWith)))
}

// tellReaders announces a change to a page, written at seq, to those who
// may see it. Those who no longer may are told too: everyone, when the page
// was everyone's, so that each copy can drop it; else each of them alone,
// with doc.unshared. Someone who may see it for the first time gets the
// whole page.
func (c *cx) tellReaders(seq int64, was, now core.Doc, changes map[string]core.FieldChange) error {
	audience := docAudience(now)
	if docAudience(was) == "" {
		audience = ""
	}
	data := core.EventData{ID: now.ID, Changes: changes}
	if newcomers := docAudience(was) != "" && (docAudience(now) == "" || slices.ContainsFunc(readersOf(now), func(uid string) bool { return !slices.Contains(readersOf(was), uid) })); newcomers {
		var row core.Doc
		if err := c.tx.Get(c.ctx, &row, store.Eq("id", now.ID)); err != nil {
			return err
		}
		data.Row = row
	}
	if err := c.emit(event{seq: seq, typ: "doc.updated", entity: "doc", entityID: now.ID, place: inDoc(now), audience: audience, data: data}); err != nil {
		return err
	}
	if docAudience(now) == "" {
		return nil
	}
	for _, uid := range readersOf(was) {
		if slices.Contains(readersOf(now), uid) {
			continue
		}
		if err := c.emit(event{seq: c.tx.NextSeq(), typ: "doc.unshared", entity: "doc", entityID: now.ID, place: place{scopeType: "user", scopeID: uid, projectID: now.ProjectID}, audience: uid, data: core.EventData{ID: now.ID, Gone: true}}); err != nil {
			return err
		}
	}
	return nil
}

// passReadersDown gives the pages under a page the readers it now has, as a
// page made under it would get them. It takes those that had the readers
// the page had before, down to the first that had others: a sub-page given
// its own (made private alone, or someone else's private page) keeps them,
// and so does what is under it. Pages in the trash count, so one restored
// later is as private as its parent. Each is told as the page was, and
// search keeps each to its readers.
func (c *cx) passReadersDown(was, now core.Doc) error {
	below, err := c.below(was, func(k core.Doc) bool { return sameReaders(k, was) })
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("owner_id", was.OwnerID, now.OwnerID)
	p.put("shared_with", was.SharedWith, now.SharedWith)
	for _, d := range below {
		seq := c.tx.NextSeq()
		p.set["updated_seq"] = seq
		if _, err := c.tx.Update(c.ctx, "docs", p.set, store.Eq("id", d.ID)); err != nil {
			return err
		}
		after := d
		after.OwnerID, after.SharedWith = now.OwnerID, now.SharedWith
		if err := c.tellReaders(seq, d, after, p.changes); err != nil {
			return err
		}
		if d.DeletedAt != 0 {
			continue // not in search while it is in the trash
		}
		if err := c.reindexDoc(after); err != nil {
			return err
		}
	}
	return nil
}
