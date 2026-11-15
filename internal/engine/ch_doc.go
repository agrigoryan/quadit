package engine

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("doc.create", core.RoleMember, docCreate)
	register("doc.update", core.RoleMember, docUpdate)
	register("doc.delete", core.RoleMember, docDelete)
	register("doc.restore", core.RoleMember, docRestore)
	register("doc.edit", core.RoleMember, docEdit)
	register("doc.write", core.RoleMember, docWrite)
	register("doc.snapshot", core.RoleMember, docSnapshot)
	register("doc.revert", core.RoleMember, docRevert)
}

// BlockTree arranges a page's stored blocks as the editor's tree.
func BlockTree(rows []core.Block) []md.Block {
	kids := map[string][]core.Block{}
	for _, r := range rows {
		if r.DeletedAt == 0 {
			kids[r.ParentID] = append(kids[r.ParentID], r)
		}
	}
	var build func(parent string) []md.Block
	build = func(parent string) []md.Block {
		list := kids[parent]
		sort.Slice(list, func(i, j int) bool {
			if list[i].Rank != list[j].Rank {
				return list[i].Rank < list[j].Rank
			}
			return list[i].ID < list[j].ID
		})
		var out []md.Block
		for _, r := range list {
			b := md.Block{ID: r.ID, Type: r.Type, Content: r.Content, Children: build(r.ID)}
			if len(r.Props) > 0 {
				json.Unmarshal(r.Props, &b.Props)
			}
			out = append(out, b)
		}
		return out
	}
	return build("")
}

// LoadBlocks returns a page's live blocks.
func LoadBlocks(c interface {
	List(dst any, q store.Q) error
}, docID string) ([]core.Block, error) {
	var rows []core.Block
	err := c.List(&rows, store.Q{Where: []store.Cond{store.Eq("doc_id", docID), store.Live}, Order: "rank"})
	return rows, err
}

type cxLister struct{ c *cx }

func (l cxLister) List(dst any, q store.Q) error { return l.c.tx.List(l.c.ctx, dst, q) }

// docAudience is who alone may see a page's events: its owner when the
// page is private.
func docAudience(d core.Doc) string { return d.OwnerID }

// ---- pages ----

type docCreateArgs struct {
	ID         string          `json:"id"`
	Parent     string          `json:"parent"`
	Title      string          `json:"title"`
	Icon       string          `json:"icon"`
	Kind       string          `json:"kind"` // page (default) or database; a page under a database is a row
	Project    string          `json:"project"`
	Private    bool            `json:"private"`
	SharedWith []string        `json:"shared_with"`
	Generated  string          `json:"generated"` // decision_log, changelog or open_questions
	MemoryOf   string          `json:"memory_of"` // the agent whose notes this is; "me"
	Rank       string          `json:"rank"`
	Markdown   string          `json:"markdown"` // the page's first content
	Blocks     []md.Block      `json:"blocks"`   // or its first content as blocks
	Props      json.RawMessage `json:"props"`    // a row's values, by property id
}

var generatedKinds = []string{"decision_log", "changelog", "open_questions"}

func docCreate(c *cx) error {
	var a docCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	did, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	d := core.Doc{ID: did, WorkspaceID: c.ws, Kind: a.Kind, Title: strings.TrimSpace(a.Title), Icon: a.Icon, Generated: a.Generated, Props: a.Props,
		CreatedBy: c.actor.UserID, UpdatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	if d.Kind == "" {
		d.Kind = core.DocPage
	}
	if d.Kind != core.DocPage && d.Kind != core.DocDatabase {
		return oneOf("kind", "kind", a.Kind, []string{core.DocPage, core.DocDatabase})
	}
	if a.Generated != "" && !contains(generatedKinds, a.Generated) {
		return oneOf("generated", "generated page", a.Generated, generatedKinds)
	}
	if a.Parent != "" {
		parent, err := c.doc("parent", a.Parent)
		if err != nil {
			return err
		}
		d.ParentID, d.ProjectID = parent.ID, parent.ProjectID
		// A page under a private page is private the same way.
		d.OwnerID, d.SharedWith, d.MemoryOf = parent.OwnerID, parent.SharedWith, parent.MemoryOf
		d.SourceID = parent.SourceID // a page made inside a mirrored folder becomes a file there
		if parent.Kind == core.DocDatabase && d.Kind == core.DocPage {
			d.Kind = core.DocRow
		}
	}
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		d.ProjectID = p.ID
	}
	if a.Private {
		d.OwnerID = c.actor.UserID
		for _, ref := range a.SharedWith {
			m, err := c.memberRef("shared_with", ref)
			if err != nil {
				return err
			}
			d.SharedWith = append(d.SharedWith, m.UserID)
		}
	}
	if a.MemoryOf != "" {
		m, err := c.memberRef("memory_of", a.MemoryOf)
		if err != nil {
			return err
		}
		if m.Kind != core.KindAgent {
			return invalid("memory_of", "memory pages belong to agents")
		}
		d.MemoryOf = m.UserID
	}
	if len(a.Props) > 0 {
		var given map[string]json.RawMessage
		if err := json.Unmarshal(a.Props, &given); err != nil {
			return invalid("props", "props must be a JSON object")
		}
		if d.Kind == core.DocRow {
			if given, err = c.rowProps(d.ParentID, given); err != nil {
				return err
			}
			d.Props, _ = json.Marshal(given)
		}
	}
	if d.Rank = a.Rank; d.Rank == "" {
		conds := []store.Cond{store.Live, store.Null("parent_id")}
		if d.ParentID != "" {
			conds = []store.Cond{store.Live, store.Eq("parent_id", d.ParentID)}
		}
		if d.Rank, err = nextRank[core.Doc](c, conds...); err != nil {
			return err
		}
	} else if !rank.Valid(d.Rank) {
		return invalid("rank", "%q is not a rank", d.Rank)
	}
	seq := c.tx.NextSeq()
	d.CreatedSeq, d.UpdatedSeq, d.ContentSeq = seq, seq, seq
	if err := c.tx.Insert(c.ctx, d); err != nil {
		return taken(err, "id", did)
	}
	blocks := a.Blocks
	if len(blocks) == 0 && a.Markdown != "" {
		blocks = md.Parse(a.Markdown)
	}
	ed := newEditor(c, d, nil)
	for i, b := range blocks {
		if err := ed.insert(b, "", rank.ForNumber(i+1)); err != nil {
			return err
		}
	}
	rows, _, err := ed.flush(seq)
	if err != nil {
		return err
	}
	c.ref = d.ID
	data := map[string]any{"row": d}
	if len(rows) > 0 {
		data["blocks"] = rows
	}
	if err := c.emitTo(docAudience(d), seq, "doc.created", "doc", d.ID, "doc", d.ID, d.ProjectID, data); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "doc", d.ID); err != nil {
		return err
	}
	return c.afterDocText(d, ed)
}

// afterDocText keeps search and mentions in step with a page's text.
func (c *cx) afterDocText(d core.Doc, ed *editor) error {
	text := ed.plain()
	mentioned, err := c.link("doc", d.ID, "doc", d.ID, d.Title+"\n"+text)
	if err != nil {
		return err
	}
	for _, m := range mentioned {
		// A page built from the data names people because the data does;
		// nobody wrote to them.
		if !CanSeeDoc(d, m.UserID) || d.Generated != "" {
			continue
		}
		if err := c.notify(m.UserID, core.NoteMentioned, core.Notification{DocID: d.ID, EntityType: "doc", EntityID: d.ID, Title: d.Title, Snippet: snippet(text, 200)}); err != nil {
			return err
		}
	}
	if len(text) > 200_000 {
		text = text[:200_000]
	}
	return c.index("doc", d.ID, "doc", d.ID, d.ProjectID, d.OwnerID, d.Title, text)
}

type docUpdateArgs struct {
	ID         string        `json:"id"`
	Title      Opt[string]   `json:"title"`
	Icon       Opt[string]   `json:"icon"`
	Cover      Opt[string]   `json:"cover"`
	Parent     Opt[string]   `json:"parent"`
	Rank       Opt[string]   `json:"rank"`
	Project    Opt[string]   `json:"project"`
	Private    Opt[bool]     `json:"private"`
	SharedWith Opt[[]string] `json:"shared_with"`
	Archived   Opt[bool]     `json:"archived"`
	// Props is merged into the page's props: a null value removes a key.
	Props map[string]json.RawMessage `json:"props"`
}

// canEditDoc refuses changes to pages the actor may only read.
func (c *cx) canEditDoc(d core.Doc) error {
	if d.Generated != "" && !c.system {
		return conflictErr("this page is built from data and cannot be edited by hand")
	}
	if d.SourceID != "" && !c.system {
		var src core.DocSource
		if err := c.tx.Get(c.ctx, &src, store.Eq("id", d.SourceID), store.Live); err == nil && src.Authority == "repo" && src.WriteMode == "none" {
			return conflictErr("this page mirrors a file in a repository that is read-only here; change the file instead")
		}
	}
	return nil
}

func docUpdate(c *cx) error {
	var a docUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, err := c.doc("id", a.ID)
	if err != nil {
		return err
	}
	wasAudience := docAudience(d)
	var unshared []string // those who could see the page and no longer can
	p := newPatch()
	p.str("title", a.Title, &d.Title)
	p.str("icon", a.Icon, &d.Icon)
	p.str("cover", a.Cover, &d.Cover)
	if a.Parent.Set {
		pid := ""
		if !a.Parent.Null && a.Parent.V != "" {
			parent, err := c.doc("parent", a.Parent.V)
			if err != nil {
				return err
			}
			for cur, depth := parent, 0; ; depth++ {
				if cur.ID == d.ID || depth > 60 {
					return invalid("parent", "a page cannot be placed inside itself")
				}
				if cur.ParentID == "" {
					break
				}
				if err := c.tx.Get(c.ctx, &cur, store.Eq("id", cur.ParentID)); err != nil {
					break
				}
			}
			pid = parent.ID
		}
		p.put("parent_id", d.ParentID, pid)
	}
	if err := p.rank(a.Rank, &d.Rank); err != nil {
		return err
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
		p.put("project_id", d.ProjectID, pid)
	}
	if a.Private.Set {
		if d.OwnerID != "" && d.OwnerID != c.actor.UserID {
			return forbidden("only its owner can change who sees a private page")
		}
		owner := ""
		if a.Private.V {
			owner = c.actor.UserID
		}
		p.put("owner_id", d.OwnerID, owner)
		d.OwnerID = owner
	}
	if a.SharedWith.Set {
		var ids []string
		for _, ref := range a.SharedWith.V {
			m, err := c.memberRef("shared_with", ref)
			if err != nil {
				return err
			}
			ids = append(ids, m.UserID)
		}
		p.put("shared_with", d.SharedWith, ids)
		for _, was := range d.SharedWith {
			if !contains(ids, was) {
				unshared = append(unshared, was)
			}
		}
	}
	if a.Archived.Set {
		if a.Archived.V && d.ArchivedAt == 0 {
			p.put("archived_at", int64(0), c.at)
		} else if !a.Archived.V && d.ArchivedAt != 0 {
			p.put("archived_at", d.ArchivedAt, int64(0))
		}
	}
	if len(a.Props) > 0 {
		if d.Kind == core.DocRow {
			if a.Props, err = c.rowProps(d.ParentID, a.Props); err != nil {
				return err
			}
		}
		cur := map[string]json.RawMessage{}
		if len(d.Props) > 0 {
			json.Unmarshal(d.Props, &cur)
		}
		changed := map[string]any{}
		for k, v := range a.Props {
			if string(v) == "null" {
				if _, had := cur[k]; had {
					delete(cur, k)
					changed[k] = nil
				}
			} else if string(cur[k]) != string(v) {
				cur[k] = v
				changed[k] = v
			}
		}
		if len(changed) > 0 {
			raw, _ := json.Marshal(cur)
			p.set["props"] = json.RawMessage(raw)
			// The event carries only the keys that changed, to merge.
			p.changes["props"] = core.FieldChange{To: json.RawMessage(raw)}
		}
	}
	c.ref = d.ID
	if p.empty() {
		return nil
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"], p.set["updated_at"], p.set["updated_by"] = seq, c.at, c.actor.UserID
	if _, err := c.tx.Update(c.ctx, "docs", p.set, store.Eq("id", d.ID)); err != nil {
		return err
	}
	// Going private must still tell everyone, so their copy can drop it.
	audience := docAudience(d)
	if wasAudience == "" {
		audience = ""
	}
	data := map[string]any{"id": d.ID, "changes": p.changes}
	if _, sharing := p.set["shared_with"]; sharing || wasAudience != docAudience(d) {
		// Someone may be seeing this page for the first time: send all of it.
		var now core.Doc
		if err := c.tx.Get(c.ctx, &now, store.Eq("id", d.ID)); err != nil {
			return err
		}
		data["row"] = now
	}
	if err := c.emitTo(audience, seq, "doc.updated", "doc", d.ID, "doc", d.ID, d.ProjectID, data); err != nil {
		return err
	}
	if docAudience(d) != "" {
		// Someone the page is no longer shared with stops getting its events:
		// tell each of them, alone, to let go of their copy.
		for _, uid := range unshared {
			if err := c.emitTo(uid, c.tx.NextSeq(), "doc.unshared", "doc", d.ID, "user", uid, d.ProjectID,
				map[string]any{"id": d.ID, "gone": true}); err != nil {
				return err
			}
		}
	}
	if _, ok := p.set["title"]; ok {
		rows, err := LoadBlocks(cxLister{c}, d.ID)
		if err != nil {
			return err
		}
		return c.afterDocText(d, newEditor(c, d, rows))
	}
	return nil
}

// subtree returns a page and every page under it.
func (c *cx) subtree(root core.Doc, deletedAt int64) ([]core.Doc, error) {
	out := []core.Doc{root}
	for i := 0; i < len(out) && len(out) < 20_000; i++ {
		var kids []core.Doc
		conds := []store.Cond{store.Eq("parent_id", out[i].ID)}
		if deletedAt == 0 {
			conds = append(conds, store.Live)
		} else {
			conds = append(conds, store.Eq("deleted_at", deletedAt))
		}
		if err := c.tx.List(c.ctx, &kids, store.Q{Where: conds}); err != nil {
			return nil, err
		}
		out = append(out, kids...)
	}
	return out, nil
}

// docDelete moves a page and the pages under it to the trash.
func docDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, err := c.doc("id", a.ID)
	if err != nil {
		return err
	}
	all, err := c.subtree(d, 0)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	ids := make([]string, len(all))
	for i, x := range all {
		ids[i] = x.ID
		if err := c.tx.Unindex(c.ctx, x.ID); err != nil {
			return err
		}
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"deleted_at": c.at, "updated_seq": seq}, store.In("id", ids)); err != nil {
		return err
	}
	c.ref = d.ID
	return c.emitTo(docAudience(d), seq, "doc.deleted", "doc", d.ID, "doc", d.ID, d.ProjectID,
		map[string]any{"ids": ids, "changes": map[string]core.FieldChange{"deleted_at": {To: c.at}}})
}

func docRestore(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	var d core.Doc
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", a.ID)); err != nil {
		return missing(err, "doc", a.ID)
	}
	if !CanSeeDoc(d, c.actor.UserID) {
		return notFound("doc", a.ID)
	}
	c.ref = d.ID
	if d.DeletedAt == 0 {
		return nil
	}
	// Restore what went to the trash together, at the same moment.
	all, err := c.subtree(d, d.DeletedAt)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	ids := make([]string, len(all))
	for i, x := range all {
		ids[i] = x.ID
	}
	set := map[string]any{"deleted_at": int64(0), "updated_seq": seq}
	// A page whose parent is still in the trash comes back at the top.
	if d.ParentID != "" {
		var parent core.Doc
		if err := c.tx.Get(c.ctx, &parent, store.Eq("id", d.ParentID), store.Live); err != nil {
			if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"parent_id": ""}, store.Eq("id", d.ID)); err != nil {
				return err
			}
		}
	}
	if _, err := c.tx.Update(c.ctx, "docs", set, store.In("id", ids)); err != nil {
		return err
	}
	if err := c.emitTo(docAudience(d), seq, "doc.restored", "doc", d.ID, "doc", d.ID, d.ProjectID,
		map[string]any{"ids": ids, "changes": map[string]core.FieldChange{"deleted_at": {To: nil}}}); err != nil {
		return err
	}
	for _, x := range all {
		rows, err := LoadBlocks(cxLister{c}, x.ID)
		if err != nil {
			return err
		}
		x.DeletedAt = 0
		if err := c.afterDocText(x, newEditor(c, x, rows)); err != nil {
			return err
		}
	}
	return nil
}

// ---- blocks ----

// BlockOp is one edit to a page: insert, update, move or delete a block.
type BlockOp struct {
	Op string `json:"op"`
	// insert: the new block (with nested blocks, if any).
	Block *md.Block `json:"block,omitempty"`
	// update, move, delete: the block's id.
	ID string `json:"id,omitempty"`
	// update: the fields to replace.
	Type    string           `json:"type,omitempty"`
	Props   *json.RawMessage `json:"props,omitempty"`
	Content *json.RawMessage `json:"content,omitempty"`
	// insert, move: where it goes. Parent "" is the top level. Give the
	// block it comes after or before, or a rank made by the caller; with
	// none of them it goes last.
	Parent string `json:"parent,omitempty"`
	After  string `json:"after,omitempty"`
	Before string `json:"before,omitempty"`
	Rank   string `json:"rank,omitempty"`
}

// editor applies block edits to a page in memory, then writes what changed.
type editor struct {
	c       *cx
	doc     core.Doc
	rows    map[string]*core.Block
	state   map[string]string // id -> new, dirty or gone
	touched []string
}

func newEditor(c *cx, d core.Doc, rows []core.Block) *editor {
	e := &editor{c: c, doc: d, rows: map[string]*core.Block{}, state: map[string]string{}}
	for i := range rows {
		e.rows[rows[i].ID] = &rows[i]
	}
	return e
}

func (e *editor) mark(id, state string) {
	if _, seen := e.state[id]; !seen {
		e.touched = append(e.touched, id)
		e.state[id] = state
		return
	}
	if state == "gone" || e.state[id] != "new" {
		e.state[id] = state
	}
}

// siblings returns the live children of a parent in order.
func (e *editor) siblings(parent string) []*core.Block {
	var out []*core.Block
	for _, r := range e.rows {
		if r.ParentID == parent && r.DeletedAt == 0 {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Rank != out[j].Rank {
			return out[i].Rank < out[j].Rank
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// place works out a rank from "after", "before", a given rank, or the end.
func (e *editor) place(op BlockOp, self string) (string, error) {
	if op.Rank != "" {
		if !rank.Valid(op.Rank) {
			return "", invalid("ops.rank", "%q is not a rank", op.Rank)
		}
		return op.Rank, nil
	}
	sibs := e.siblings(op.Parent)
	var list []*core.Block
	for _, s := range sibs {
		if s.ID != self {
			list = append(list, s)
		}
	}
	for i, s := range list {
		if op.After != "" && s.ID == op.After {
			next := ""
			if i+1 < len(list) {
				next = list[i+1].Rank
			}
			return rank.Between(s.Rank, next), nil
		}
		if op.Before != "" && s.ID == op.Before {
			prev := ""
			if i > 0 {
				prev = list[i-1].Rank
			}
			return rank.Between(prev, s.Rank), nil
		}
	}
	if len(list) == 0 {
		return rank.ForNumber(1), nil
	}
	if op.Before != "" && op.After == "" {
		return rank.Before(list[0].Rank), nil
	}
	return rank.After(list[len(list)-1].Rank), nil
}

func (e *editor) insert(b md.Block, parent, rk string) error {
	bid, err := newID("ops.block.id", b.ID)
	if err != nil {
		return err
	}
	if b.Type == "" {
		return invalid("ops.block.type", "a block needs a type")
	}
	if parent != "" {
		if p, ok := e.rows[parent]; !ok || p.DeletedAt != 0 {
			return invalid("ops.parent", "the parent block %s is not in this page", parent)
		}
	}
	var props json.RawMessage
	if len(b.Props) > 0 {
		props, _ = json.Marshal(b.Props)
	}
	if old, ok := e.rows[bid]; ok {
		// The same insert sent twice, or a block coming back: bring it up to date.
		old.Type, old.Props, old.Content, old.ParentID, old.Rank, old.DeletedAt = b.Type, props, b.Content, parent, rk, 0
		old.Plain, old.UpdatedBy = md.Plain(b), e.c.actor.UserID
		e.mark(bid, "dirty")
	} else {
		e.rows[bid] = &core.Block{ID: bid, WorkspaceID: e.c.ws, DocID: e.doc.ID, ParentID: parent, Rank: rk, Type: b.Type, Props: props,
			Content: b.Content, Plain: md.Plain(b), CreatedBy: e.c.actor.UserID, UpdatedBy: e.c.actor.UserID}
		e.mark(bid, "new")
	}
	for i, ch := range b.Children {
		if err := e.insert(ch, bid, rank.ForNumber(i+1)); err != nil {
			return err
		}
	}
	return nil
}

func (e *editor) remove(id string) {
	r, ok := e.rows[id]
	if !ok || r.DeletedAt != 0 {
		return
	}
	r.DeletedAt = e.c.at
	e.mark(id, "gone")
	for _, ch := range e.siblings(id) {
		e.remove(ch.ID)
	}
}

func (e *editor) apply(op BlockOp) error {
	switch op.Op {
	case "insert":
		if op.Block == nil {
			return invalid("ops.block", "an insert needs a block")
		}
		rk, err := e.place(op, op.Block.ID)
		if err != nil {
			return err
		}
		return e.insert(*op.Block, op.Parent, rk)
	case "update":
		r, ok := e.rows[op.ID]
		if !ok || r.DeletedAt != 0 {
			return nil // deleted by someone else meanwhile: nothing to update
		}
		if op.Type != "" {
			r.Type = op.Type
		}
		if op.Props != nil {
			r.Props = *op.Props
			if p := strings.TrimSpace(string(r.Props)); p == "{}" || p == "null" {
				r.Props = nil // no props is stored as nothing
			}
		}
		if op.Content != nil {
			r.Content = *op.Content
		}
		r.Plain, r.UpdatedBy = md.Plain(md.Block{Type: r.Type, Content: r.Content}), e.c.actor.UserID
		e.mark(op.ID, "dirty")
	case "move":
		r, ok := e.rows[op.ID]
		if !ok || r.DeletedAt != 0 {
			return nil
		}
		for cur := op.Parent; cur != ""; {
			if cur == op.ID {
				return invalid("ops.parent", "a block cannot be moved inside itself")
			}
			p, ok := e.rows[cur]
			if !ok {
				return invalid("ops.parent", "the parent block %s is not in this page", cur)
			}
			cur = p.ParentID
		}
		rk, err := e.place(op, op.ID)
		if err != nil {
			return err
		}
		r.ParentID, r.Rank, r.UpdatedBy = op.Parent, rk, e.c.actor.UserID
		e.mark(op.ID, "dirty")
	case "delete":
		e.remove(op.ID)
	default:
		return oneOf("ops.op", "op", op.Op, []string{"insert", "update", "move", "delete"})
	}
	return nil
}

// flush writes the touched blocks and returns the rows written and the ids
// removed.
func (e *editor) flush(seq int64) (upserted []core.Block, deleted []string, err error) {
	for _, bid := range e.touched {
		r := e.rows[bid]
		r.UpdatedSeq = seq
		switch e.state[bid] {
		case "new":
			r.CreatedSeq = seq
			if r.DeletedAt != 0 {
				continue // added and removed in the same edit
			}
			if err := e.c.tx.Insert(e.c.ctx, *r); err != nil {
				return nil, nil, taken(err, "block id", bid)
			}
			upserted = append(upserted, *r)
		case "dirty":
			if _, err := e.c.tx.Update(e.c.ctx, "doc_blocks", map[string]any{"parent_id": r.ParentID, "rank": r.Rank, "type": r.Type, "props": r.Props,
				"content": r.Content, "plain": r.Plain, "updated_by": r.UpdatedBy, "updated_seq": seq, "deleted_at": r.DeletedAt}, store.Eq("id", bid)); err != nil {
				return nil, nil, err
			}
			upserted = append(upserted, *r)
		case "gone":
			if _, err := e.c.tx.Update(e.c.ctx, "doc_blocks", map[string]any{"deleted_at": e.c.at, "updated_seq": seq, "updated_by": e.c.actor.UserID},
				store.Eq("id", bid)); err != nil {
				return nil, nil, err
			}
			deleted = append(deleted, bid)
		}
	}
	return upserted, deleted, nil
}

func (e *editor) live() []core.Block {
	var out []core.Block
	for _, r := range e.rows {
		if r.DeletedAt == 0 {
			out = append(out, *r)
		}
	}
	return out
}

// plain returns the page's text in reading order.
func (e *editor) plain() string {
	var b strings.Builder
	var walk func([]md.Block)
	walk = func(list []md.Block) {
		for _, bl := range list {
			if t := md.Plain(bl); t != "" {
				b.WriteString(t + "\n")
			}
			walk(bl.Children)
		}
	}
	walk(BlockTree(e.live()))
	return b.String()
}

const versionEvery = 15 * 60_000 // a page keeps a version at most this often while it is edited

// commitEdit writes an edit, keeps a version of the page as it was if the
// last one is old, and tells everyone looking at the page.
func (c *cx) commitEdit(d core.Doc, ed *editor, before []core.Block, extra map[string]any) error {
	if len(ed.touched) == 0 {
		c.ref = d.ID
		return nil
	}
	// When this edit changes a block someone else wrote since the last kept
	// version, the page as they left it is kept first: the last edit wins,
	// and the other stays in the page's history.
	others, err := c.overwritesOthers(d, ed, before)
	if err != nil {
		return err
	}
	if err := c.keepVersion(d, before, "", others); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	rows, gone, err := ed.flush(seq)
	if err != nil {
		return err
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"content_seq": seq, "updated_at": c.at, "updated_by": c.actor.UserID}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	c.ref = d.ID
	data := map[string]any{"id": d.ID, "blocks": rows, "deleted": gone,
		"changes": map[string]core.FieldChange{"content_seq": {To: seq}, "updated_at": {To: c.at}, "updated_by": {To: c.actor.UserID}}}
	for k, v := range extra {
		data[k] = v
	}
	if err := c.emitTo(docAudience(d), seq, "doc.edited", "doc", d.ID, "doc", d.ID, d.ProjectID, data); err != nil {
		return err
	}
	return c.afterDocText(d, ed)
}

// overwritesOthers reports whether an edit touches a block that another
// member changed after the newest kept version.
func (c *cx) overwritesOthers(d core.Doc, ed *editor, before []core.Block) (bool, error) {
	var last []core.DocVersion
	if err := c.tx.List(c.ctx, &last, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID)}, Order: "-seq", Limit: 1}); err != nil {
		return false, err
	}
	var kept int64
	if len(last) > 0 {
		kept = last[0].Seq
	}
	for _, b := range before {
		if contains(ed.touched, b.ID) && b.UpdatedBy != "" && b.UpdatedBy != c.actor.UserID && b.UpdatedSeq > kept {
			return true, nil
		}
	}
	return false, nil
}

// keepVersion stores the page as it stands. Unless forced it does so only
// when the newest version is older than versionEvery.
func (c *cx) keepVersion(d core.Doc, rows []core.Block, label string, force bool) error {
	if !force {
		var last []core.DocVersion
		if err := c.tx.List(c.ctx, &last, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID)}, Order: "-seq", Limit: 1}); err != nil {
			return err
		}
		if (len(last) > 0 && c.at-last[0].CreatedAt < versionEvery) || len(rows) == 0 {
			return nil
		}
	}
	snap, _ := json.Marshal(BlockTree(rows))
	return c.tx.Insert(c.ctx, core.DocVersion{ID: id.New(), WorkspaceID: c.ws, DocID: d.ID, Seq: c.tx.Seq(), Label: label, Title: d.Title,
		Snapshot: snap, CreatedBy: orStr(d.UpdatedBy, d.CreatedBy), CreatedAt: c.at})
}

type docEditArgs struct {
	Doc string    `json:"doc"`
	Ops []BlockOp `json:"ops"`
}

// docEdit applies block edits to a page. Two people in one page each send
// their own blocks' edits; a block edited by both keeps the later edit.
func docEdit(c *cx) error {
	var a docEditArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, err := c.doc("doc", a.Doc)
	if err != nil {
		return err
	}
	if err := c.canEditDoc(d); err != nil {
		return err
	}
	if len(a.Ops) == 0 {
		return invalid("ops", "send at least one op")
	}
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	before := append([]core.Block(nil), rows...)
	ed := newEditor(c, d, rows)
	// A block that was deleted may come back under its own id (an undo):
	// let the editor know those rows, so the insert revives them.
	var ids []string
	var collect func(b md.Block)
	collect = func(b md.Block) {
		if b.ID != "" {
			ids = append(ids, b.ID)
		}
		for _, ch := range b.Children {
			collect(ch)
		}
	}
	for _, op := range a.Ops {
		if op.Op == "insert" && op.Block != nil {
			collect(*op.Block)
		}
	}
	if len(ids) > 0 {
		var gone []core.Block
		if err := c.tx.List(c.ctx, &gone, store.Where(store.Eq("doc_id", d.ID), store.In("id", ids), store.NotNull("deleted_at"))); err != nil {
			return err
		}
		for i := range gone {
			ed.rows[gone[i].ID] = &gone[i]
		}
	}
	for _, op := range a.Ops {
		if err := ed.apply(op); err != nil {
			return err
		}
	}
	return c.commitEdit(d, ed, before, nil)
}

type docWriteArgs struct {
	Doc      string `json:"doc"`
	Markdown string `json:"markdown"`
	// Mode: replace (default) rewrites the page, keeping the blocks that did
	// not change; append and prepend add to it.
	Mode string `json:"mode"`
}

// signature is what makes two blocks "the same" when a page is rewritten.
func signature(b md.Block) string {
	var sb strings.Builder
	props, _ := json.Marshal(b.Props)
	// Content is compared in one canonical spelling: a database may hand
	// JSON back with its keys in another order than it was given.
	var content any
	json.Unmarshal(b.Content, &content)
	canon, _ := json.Marshal(content)
	if _, inline := content.([]any); inline {
		// Text is compared as the Markdown it reads as: a mention chip and
		// the plain "@name" an agent wrote back are the same block, and the
		// chip is kept.
		canon = []byte(md.RenderInline(b.Content))
	}
	if len(b.Props) == 0 {
		props = []byte("{}")
	}
	sb.WriteString(b.Type + "\x00" + string(props) + "\x00" + string(canon))
	for _, ch := range b.Children {
		sb.WriteString("\x01" + signature(ch))
	}
	return sb.String()
}

// docWrite sets a page's content from Markdown. Blocks that are the same
// before and after keep their ids, so comments on them stay attached and
// only the real differences reach other readers.
func docWrite(c *cx) error {
	var a docWriteArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, err := c.doc("doc", a.Doc)
	if err != nil {
		return err
	}
	if err := c.canEditDoc(d); err != nil {
		return err
	}
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	before := append([]core.Block(nil), rows...)
	ed := newEditor(c, d, rows)
	fresh := md.Parse(a.Markdown)
	switch a.Mode {
	case "append", "prepend":
		for _, b := range fresh {
			op := BlockOp{Op: "insert", Block: &b}
			if a.Mode == "prepend" {
				if first := ed.siblings(""); len(first) > 0 {
					op.Before = first[0].ID
				}
			}
			if err := ed.apply(op); err != nil {
				return err
			}
		}
	case "", "replace":
		old := BlockTree(rows)
		keepOld, keepNew := lcs(old, fresh)
		for i, b := range old {
			if !keepOld[i] {
				ed.remove(b.ID)
			}
		}
		// Walk the new page; blocks kept stay where they are, new ones go
		// in after the block before them.
		prev := ""
		j := 0
		for i, b := range fresh {
			if keepNew[i] {
				for !keepOld[j] {
					j++
				}
				prev = old[j].ID
				j++
				continue
			}
			b.ID = id.New()
			op := BlockOp{Op: "insert", Block: &b, After: prev}
			if prev == "" {
				if first := ed.siblings(""); len(first) > 0 {
					op.Before = first[0].ID
				}
			}
			if err := ed.apply(op); err != nil {
				return err
			}
			prev = b.ID
		}
	default:
		return oneOf("mode", "mode", a.Mode, []string{"replace", "append", "prepend"})
	}
	return c.commitEdit(d, ed, before, nil)
}

// lcs marks the blocks two versions of a page have in common, in order.
func lcs(a, b []md.Block) (keepA, keepB []bool) {
	sa, sb := make([]string, len(a)), make([]string, len(b))
	for i := range a {
		sa[i] = signature(a[i])
	}
	for i := range b {
		sb[i] = signature(b[i])
	}
	n, m := len(a), len(b)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if sa[i] == sb[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else {
				dp[i][j] = max(dp[i+1][j], dp[i][j+1])
			}
		}
	}
	keepA, keepB = make([]bool, n), make([]bool, m)
	for i, j := 0, 0; i < n && j < m; {
		switch {
		case sa[i] == sb[j]:
			keepA[i], keepB[j] = true, true
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			i++
		default:
			j++
		}
	}
	return keepA, keepB
}

// ---- versions ----

type docSnapshotArgs struct {
	Doc   string `json:"doc"`
	Label string `json:"label"`
}

// docSnapshot keeps a named version of a page as it is now.
func docSnapshot(c *cx) error {
	var a docSnapshotArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, err := c.doc("doc", a.Doc)
	if err != nil {
		return err
	}
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	c.ref = d.ID
	d.UpdatedBy = c.actor.UserID
	return c.keepVersion(d, rows, a.Label, true)
}

type docRevertArgs struct {
	Doc     string `json:"doc"`
	Version string `json:"version"`
}

// docRevert puts a page back to a kept version. What it was just before is
// kept as a version too, so reverting can be undone.
func docRevert(c *cx) error {
	var a docRevertArgs
	if err := c.args(&a); err != nil {
		return err
	}
	d, err := c.doc("doc", a.Doc)
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
	if err := c.keepVersion(d, rows, "before reverting", true); err != nil {
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
	if err := c.emitTo(docAudience(d), seq, "doc.edited", "doc", d.ID, "doc", d.ID, d.ProjectID, map[string]any{"id": d.ID, "blocks": upserted,
		"deleted": gone, "reverted_to": v.ID, "changes": map[string]core.FieldChange{"content_seq": {To: seq}, "updated_at": {To: c.at}}}); err != nil {
		return err
	}
	return c.afterDocText(d, ed)
}
