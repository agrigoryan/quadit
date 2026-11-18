// doc.edit and doc.write: a page's blocks, by operations or as Markdown.

package engine

import (
	"cmp"
	"encoding/json"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("doc.edit", core.RoleMember, docEdit)
	register("doc.write", core.RoleMember, docWrite)
}

// commitEdit writes an edit, keeps a version of the page as it was if the
// last one is old, and tells everyone looking at the page.
func (c *cx) commitEdit(d core.Doc, ed *editor, before []core.Block) error {
	if len(ed.touched) == 0 {
		c.ref = d.ID
		return nil
	}
	if err := c.keepMarks(d, ed); err != nil {
		return err
	}
	// When this edit changes a block someone else wrote since the last kept
	// version, the page as they left it is kept first: the last edit wins,
	// and the other stays in the page's history.
	others, err := c.overwritesOthers(d, ed, before)
	if err != nil {
		return err
	}
	if others {
		_, err = c.keepVersion(d, before, "")
	} else {
		err = c.keepVersionIfDue(d, before)
	}
	if err != nil {
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
	data := core.EventData{ID: d.ID, Blocks: &rows, Deleted: gone,
		Changes: map[string]core.FieldChange{"content_seq": {To: seq}, "updated_at": {To: c.at}, "updated_by": {To: c.actor.UserID}}}
	if err := c.emit(event{seq: seq, typ: "doc.edited", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: data}); err != nil {
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
		if slices.Contains(ed.touched, b.ID) && b.UpdatedBy != "" && b.UpdatedBy != c.actor.UserID && b.UpdatedSeq > kept {
			return true, nil
		}
	}
	return false, nil
}

type docEditArgs struct {
	Doc string    `json:"doc" quadit:"required"`
	Ops []BlockOp `json:"ops" quadit:"required,handler"`
}

// docEdit applies block edits to a page. Two people in one page each send
// their own blocks' edits; a block edited by both keeps the later edit.
func docEdit(c *cx, a docEditArgs) error {
	d, err := c.loadDoc("doc", a.Doc)
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
	return c.commitEdit(d, ed, before)
}

type docWriteArgs struct {
	Doc      string `json:"doc" quadit:"required"`
	Markdown string `json:"markdown"`
	// Mode: replace (default) rewrites the page, keeping the blocks that did
	// not change; append and prepend add to it.
	Mode string `json:"mode"`
}

// signature is what makes two blocks "the same" when a page is rewritten.
func signature(b md.Block) string {
	var sb strings.Builder
	props := plainjson.Marshal(b.Props)
	// Content is compared in one canonical spelling: a database may hand
	// JSON back with its keys in another order than it was given.
	var content any
	_ = json.Unmarshal(b.Content, &content) // deliberate: unreadable content compares as null, and such a block is never taken for another
	canon := plainjson.Marshal(content)
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
func docWrite(c *cx, a docWriteArgs) error {
	d, err := c.loadDoc("doc", a.Doc)
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
	fresh, err := c.pageMarkdown(a.Markdown)
	if err != nil {
		return err
	}
	// A comment thread whose span the Markdown has is on the words the
	// spans are around, and on no others; one it leaves out stays where it
	// is (keepMarks).
	ed.placed = spanThreads(fresh)
	switch a.Mode {
	case "append", "prepend":
		for _, r := range rows {
			if content := md.TakeMarks(r.Content, json.RawMessage("[]"), ed.placed); string(content) != string(r.Content) {
				ed.setMarks(r.ID, content)
			}
		}
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
		// A block kept takes the spans written in its place.
		var respan func(was, now md.Block)
		respan = func(was, now md.Block) {
			if content := md.TakeMarks(was.Content, now.Content, ed.placed); string(content) != string(was.Content) {
				ed.setMarks(was.ID, content)
			}
			for k := range min(len(was.Children), len(now.Children)) {
				respan(was.Children[k], now.Children[k])
			}
		}
		for i, j := 0, 0; len(ed.placed) > 0 && i < len(old) && j < len(fresh); {
			switch {
			case !keepOld[i]:
				i++
			case !keepNew[j]:
				j++
			default:
				respan(old[i], fresh[j])
				i++
				j++
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
	return c.commitEdit(d, ed, before)
}

// spanThreads is the comment threads the spans of blocks read from
// Markdown name, nested blocks' too.
func spanThreads(blocks []md.Block) []string {
	var ids []string
	for _, b := range blocks {
		ids = append(ids, md.Threads(b.Content)...)
		ids = append(ids, spanThreads(b.Children)...)
	}
	slices.Sort(ids)
	return slices.Compact(ids)
}

// lcs marks the blocks two versions of a page have in common, in order:
// their longest common subsequence, of which lcs is the textbook name.
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

// pageMarkdown is Markdown read into a page's blocks, with each @handle of
// a member made a mention as the editor makes one (md.Mentions): it then
// references and tells the member as a typed mention does, and the page
// writes it back as @handle. Markdown from people and agents has the
// comment spans they read; a system write's is a file's (a repository's),
// which holds none: what looks like one there is the file's text.
func (c *cx) pageMarkdown(src string) ([]md.Block, error) {
	parse := md.ParseWithComments
	if c.system {
		parse = md.Parse
	}
	var failed error
	blocks := md.Mentions(parse(src), func(handle string) bool {
		var m core.Member
		ok, err := store.Find(c.ctx, c.tx, &m, store.Eq("handle", handle), store.Null("removed_at"))
		failed = cmp.Or(failed, err)
		return ok
	})
	return blocks, failed
}
