// doc.snapshot and doc.revert: a page's kept versions.

package engine

import (
	"encoding/json"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("doc.snapshot", core.RoleMember, docSnapshot)
	register("doc.revert", core.RoleMember, docRevert)
}

const versionEvery = 15 * msPerMinute // a page keeps a version at most this often while it is edited

// keepVersionIfDue stores the page as it stands when it has blocks and
// its newest version is older than versionEvery.
func (c *cx) keepVersionIfDue(d core.Doc, rows []core.Block) error {
	var last []core.DocVersion
	if err := c.tx.List(c.ctx, &last, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID)}, Order: "-seq", Limit: 1}); err != nil {
		return err
	}
	if (len(last) > 0 && c.at-last[0].CreatedAt < versionEvery) || len(rows) == 0 {
		return nil
	}
	return c.keepVersion(d, rows, "")
}

// keepVersion stores the page as it stands.
func (c *cx) keepVersion(d core.Doc, rows []core.Block, label string) error {
	snap, _ := json.Marshal(BlockTree(rows))
	return c.tx.Insert(c.ctx, core.DocVersion{ID: id.New(), WorkspaceID: c.ws, DocID: d.ID, Seq: c.tx.Seq(), Label: label, Title: d.Title,
		Snapshot: snap, CreatedBy: firstNonEmpty(d.UpdatedBy, d.CreatedBy), CreatedAt: c.at})
}

type docSnapshotArgs struct {
	Doc   string `json:"doc"`
	Label string `json:"label"`
}

// docSnapshot keeps a named version of a page as it is now.
func docSnapshot(c *cx, a docSnapshotArgs) error {
	d, err := c.loadDoc("doc", a.Doc)
	if err != nil {
		return err
	}
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	c.ref = d.ID
	d.UpdatedBy = c.actor.UserID
	return c.keepVersion(d, rows, a.Label)
}

type docRevertArgs struct {
	Doc     string `json:"doc"`
	Version string `json:"version"`
}

// docRevert puts a page back to a kept version. What it was just before is
// kept as a version too, so reverting can be undone.
func docRevert(c *cx, a docRevertArgs) error {
	d, err := c.loadDoc("doc", a.Doc)
	if err != nil {
		return err
	}
	if err := c.canEditDoc(d); err != nil {
		return err
	}
	var v core.DocVersion
	if err := c.tx.Get(c.ctx, &v, store.Eq("id", a.Version), store.Eq("doc_id", d.ID)); err != nil {
		return missing(err, "version", a.Version)
	}
	var snap []md.Block
	if err := json.Unmarshal(v.Snapshot, &snap); err != nil {
		return err
	}
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	if err := c.keepVersion(d, rows, "before reverting"); err != nil {
		return err
	}
	ed := newEditor(c, d, rows)
	for _, r := range rows {
		if r.ParentID == "" {
			ed.remove(r.ID)
		}
	}
	// Blocks come back under their old ids, so comments find them again.
	var all []core.Block
	if err := c.tx.List(c.ctx, &all, store.Where(store.Eq("doc_id", d.ID))); err != nil {
		return err
	}
	for i := range all {
		if _, ok := ed.rows[all[i].ID]; !ok {
			ed.rows[all[i].ID] = &all[i]
		}
	}
	for i, b := range snap {
		if err := ed.insert(b, "", rank.ForNumber(i+1)); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	upserted, gone, err := ed.flush(seq)
	if err != nil {
		return err
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"content_seq": seq, "updated_at": c.at, "updated_by": c.actor.UserID}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	c.ref = d.ID
	if err := c.emit(event{seq: seq, typ: "doc.edited", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: core.EventData{ID: d.ID, Blocks: &upserted,
		Deleted: gone, RevertedTo: v.ID, Changes: map[string]core.FieldChange{"content_seq": {To: seq}, "updated_at": {To: c.at}}}}); err != nil {
		return err
	}
	return c.afterDocText(d, ed)
}
