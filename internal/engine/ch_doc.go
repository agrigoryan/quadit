// doc.create, doc.update, doc.delete and doc.restore: pages.

package engine

import (
	"encoding/json"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers doc.create, doc.update, doc.delete and doc.restore.
func init() {
	register("doc.create", core.RoleMember, docCreate)
	register("doc.update", core.RoleMember, docUpdate)
	register("doc.delete", core.RoleMember, docDelete)
	register("doc.restore", core.RoleMember, docRestore)
}

// docAudience is who alone may see a page's events: its owner when the
// page is private.
func docAudience(d core.Doc) string { return d.OwnerID }

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

// docCreate makes a page, or a database, or a row of one when its parent is
// a database.
func docCreate(c *cx, a docCreateArgs) error {
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
	if a.Generated != "" && !slices.Contains(generatedKinds, a.Generated) {
		return oneOf("generated", "generated page", a.Generated, generatedKinds)
	}
	if err := c.placeDoc(&d, a); err != nil {
		return err
	}
	if err := c.docReaders(&d, a); err != nil {
		return err
	}
	if err := c.newDocProps(&d, a); err != nil {
		return err
	}
	if err := c.newDocRank(&d, a.Rank); err != nil {
		return err
	}
	return c.insertDoc(d, a)
}

// placeDoc puts a new page under its parent and in its project. What the
// parent is, the page is too: private, an agent's memory, a mirrored file.
func (c *cx) placeDoc(d *core.Doc, a docCreateArgs) error {
	if a.Parent != "" {
		parent, err := c.loadDoc("parent", a.Parent)
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
		project, err := c.project(a.Project)
		if err != nil {
			return err
		}
		d.ProjectID = project.ID
	}
	return nil
}

// docReaders says who sees a new page that is private, and whose memory it
// is when it is an agent's.
func (c *cx) docReaders(d *core.Doc, a docCreateArgs) error {
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
	return nil
}

// newDocProps checks a new page's properties. A row's are stored the way
// its database's columns say.
func (c *cx) newDocProps(d *core.Doc, a docCreateArgs) error {
	if len(a.Props) == 0 {
		return nil
	}
	var given map[string]json.RawMessage
	if err := json.Unmarshal(a.Props, &given); err != nil {
		return invalid("props", "props must be a JSON object")
	}
	if d.Kind == core.DocRow {
		var err error
		if given, err = c.rowProps(d.ParentID, given); err != nil {
			return err
		}
		d.Props, _ = json.Marshal(given)
	}
	return nil
}

// newDocRank places a new page among its siblings: where the caller said,
// or after the last.
func (c *cx) newDocRank(d *core.Doc, given string) error {
	var err error
	if d.Rank = given; d.Rank == "" {
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
	return nil
}

// insertDoc writes a new page with the blocks it starts with, and says so.
func (c *cx) insertDoc(d core.Doc, a docCreateArgs) error {
	seq := c.tx.NextSeq()
	d.CreatedSeq, d.UpdatedSeq, d.ContentSeq = seq, seq, seq
	if err := c.tx.Insert(c.ctx, d); err != nil {
		return alreadyInUse(err, "id", d.ID)
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
	data := core.EventData{Row: d}
	if len(rows) > 0 {
		data.Blocks = &rows
	}
	if err := c.emit(event{seq: seq, typ: "doc.created", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: data}); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "doc", d.ID); err != nil {
		return err
	}
	return c.afterDocText(d, ed)
}

// afterDocText keeps search and mentions in step with a page's text.
func (c *cx) afterDocText(d core.Doc, ed *editor) error {
	text := ed.plainText()
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
	return c.index(store.SearchDoc{Kind: "doc", EntityID: d.ID, ScopeType: "doc", ScopeID: d.ID, ProjectID: d.ProjectID, AudienceID: d.OwnerID, Title: d.Title, Body: text})
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
		ok, err := found(c.tx.Get(c.ctx, &src, store.Eq("id", d.SourceID), store.Live))
		if err != nil {
			return err
		}
		if ok && src.Authority == core.AuthorityRepo && src.WriteMode == core.WriteNone {
			return conflictErr("this page mirrors a file in a repository that is read-only here; change the file instead")
		}
	}
	return nil
}

// docUpdate changes what a page is called, where it sits, who sees it and
// its properties. Its text is changed with doc.edit and doc.write.
func docUpdate(c *cx, a docUpdateArgs) error {
	d, err := c.loadDoc("id", a.ID)
	if err != nil {
		return err
	}
	u := &pageEdit{c: c, a: a, d: d, p: newPatch(), wasAudience: docAudience(d)}
	steps := []func() error{
		u.look,
		u.parent,
		u.rank,
		u.project,
		u.private,
		u.sharedWith,
		u.archived,
		u.props,
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	c.ref = d.ID
	if u.p.empty() {
		return nil
	}
	return u.save()
}

// pageEdit is one doc.update under way: the page as it is becoming, the
// patch that takes it there, and who could see it before.
type pageEdit struct {
	c           *cx
	a           docUpdateArgs
	d           core.Doc
	p           *patch
	wasAudience string
	unshared    []string // those who could see the page and no longer can
	moved       bool     // its project changes
	toProject   string   // to this one; none when empty
}

// look sets what the page is called and how it looks: its title, icon and
// cover.
func (u *pageEdit) look() error {
	u.p.setText("title", u.a.Title, &u.d.Title)
	u.p.setText("icon", u.a.Icon, &u.d.Icon)
	u.p.setText("cover", u.a.Cover, &u.d.Cover)
	return nil
}

// parent moves the page under another, which may not be one of its own.
func (u *pageEdit) parent() error {
	c, a, d := u.c, u.a, u.d
	if !a.Parent.Set {
		return nil
	}
	pid := ""
	if !a.Parent.Null && a.Parent.V != "" {
		parent, err := c.loadDoc("parent", a.Parent.V)
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
			ok, err := found(c.tx.Get(c.ctx, &cur, store.Eq("id", cur.ParentID)))
			if err != nil {
				return err
			}
			if !ok {
				break
			}
		}
		pid = parent.ID
	}
	u.p.put("parent_id", d.ParentID, pid)
	return nil
}

func (u *pageEdit) rank() error {
	return u.p.rank(u.a.Rank, &u.d.Rank)
}

// private makes the page its owner's alone, or everyone's again.
func (u *pageEdit) private() error {
	c, d := u.c, &u.d
	if !u.a.Private.Set {
		return nil
	}
	if d.OwnerID != "" && d.OwnerID != c.actor.UserID {
		return forbidden("only its owner can change who sees a private page")
	}
	owner := ""
	if u.a.Private.V {
		owner = c.actor.UserID
	}
	u.p.put("owner_id", d.OwnerID, owner)
	d.OwnerID = owner
	return nil
}

// sharedWith sets who a private page is shared with, and notes who it no
// longer is.
func (u *pageEdit) sharedWith() error {
	if !u.a.SharedWith.Set {
		return nil
	}
	var ids []string
	for _, ref := range u.a.SharedWith.V {
		m, err := u.c.memberRef("shared_with", ref)
		if err != nil {
			return err
		}
		ids = append(ids, m.UserID)
	}
	u.p.put("shared_with", u.d.SharedWith, ids)
	for _, was := range u.d.SharedWith {
		if !slices.Contains(ids, was) {
			u.unshared = append(u.unshared, was)
		}
	}
	return nil
}

func (u *pageEdit) archived() error {
	a, d := u.a, u.d
	u.p.setStamp("archived_at", a.Archived, d.ArchivedAt, u.c.at)
	return nil
}

// props merges the properties given into the page's own.
func (u *pageEdit) props() error {
	d, p, props := u.d, u.p, u.a.Props
	if len(props) == 0 {
		return nil
	}
	if d.Kind == core.DocRow {
		var err error
		if props, err = u.c.rowProps(d.ParentID, props); err != nil {
			return err
		}
	}
	cur := map[string]json.RawMessage{}
	if len(d.Props) > 0 {
		if err := json.Unmarshal(d.Props, &cur); err != nil {
			return err
		}
	}
	changed := map[string]any{}
	for k, v := range props {
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
	return nil
}

// save writes the patch and tells those who see the page, and those who no
// longer do.
func (u *pageEdit) save() error {
	c, d, p := u.c, u.d, u.p
	seq := c.tx.NextSeq()
	p.set["updated_seq"], p.set["updated_at"], p.set["updated_by"] = seq, c.at, c.actor.UserID
	if _, err := c.tx.Update(c.ctx, "docs", p.set, store.Eq("id", d.ID)); err != nil {
		return err
	}
	// Going private must still tell everyone, so their copy can drop it.
	audience := docAudience(d)
	if u.wasAudience == "" {
		audience = ""
	}
	data := core.EventData{ID: d.ID, Changes: p.changes}
	if _, sharing := p.set["shared_with"]; sharing || u.wasAudience != docAudience(d) {
		// Someone may be seeing this page for the first time: send all of it.
		var now core.Doc
		if err := c.tx.Get(c.ctx, &now, store.Eq("id", d.ID)); err != nil {
			return err
		}
		data.Row = now
	}
	if err := c.emit(event{seq: seq, typ: "doc.updated", entity: "doc", entityID: d.ID, place: inDoc(d), audience: audience, data: data}); err != nil {
		return err
	}
	if docAudience(d) != "" {
		// Someone the page is no longer shared with stops getting its events:
		// tell each of them, alone, to let go of their copy.
		for _, uid := range u.unshared {
			if err := c.emit(event{seq: c.tx.NextSeq(), typ: "doc.unshared", entity: "doc", entityID: d.ID, place: place{scopeType: "user", scopeID: uid, projectID: d.ProjectID}, audience: uid, data: core.EventData{ID: d.ID, Gone: true}}); err != nil {
				return err
			}
		}
	}
	if u.moved {
		if err := c.tellNewProject(d); err != nil {
			return err
		}
		// The pages under it that are in the project because it is go with it.
		if err := c.moveSubPages(d, u.toProject); err != nil {
			return err
		}
		d.ProjectID = u.toProject
	}
	// Search knows a page by its title, and keeps it to those who may see its project.
	if _, ok := p.set["title"]; ok || u.moved {
		return c.reindexDoc(d)
	}
	return nil
}

// reindexDoc puts a page as it is now back into search and the mention lists.
func (c *cx) reindexDoc(d core.Doc) error {
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	return c.afterDocText(d, newEditor(c, d, rows))
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
func docDelete(c *cx, a idArgs) error {
	d, err := c.loadDoc("id", a.ID)
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
	return c.emit(event{seq: seq, typ: "doc.deleted", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: core.EventData{IDs: ids, Changes: map[string]core.FieldChange{"deleted_at": {To: c.at}}}})
}

// docRestore takes a page out of the trash, with the pages that went there
// with it.
func docRestore(c *cx, a idArgs) error {
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
	// A page that came from a repository forgets what it last agreed on
	// with its file: brought back, it is written there again, not taken
	// for a page whose file was deleted and sent back to the trash.
	set := map[string]any{"deleted_at": int64(0), "updated_seq": seq, "source_hash": ""}
	// A page whose parent is still in the trash comes back at the top.
	if d.ParentID != "" {
		var parent core.Doc
		ok, err := found(c.tx.Get(c.ctx, &parent, store.Eq("id", d.ParentID), store.Live))
		if err != nil {
			return err
		}
		if !ok {
			if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"parent_id": ""}, store.Eq("id", d.ID)); err != nil {
				return err
			}
		}
	}
	if _, err := c.tx.Update(c.ctx, "docs", set, store.In("id", ids)); err != nil {
		return err
	}
	if err := c.emit(event{seq: seq, typ: "doc.restored", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: core.EventData{IDs: ids, Changes: map[string]core.FieldChange{"deleted_at": {To: nil}}}}); err != nil {
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
