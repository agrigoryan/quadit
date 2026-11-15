package engine

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

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
				_ = json.Unmarshal(r.Props, &b.Props) // deliberate: the engine wrote these props as JSON; a block whose props cannot be read shows without them
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

func (e *editor) setBlockState(id, state string) {
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

// rankFor works out a rank from "after", "before", a given rank, or the end.
func (e *editor) rankFor(op BlockOp, self string) (string, error) {
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
		e.setBlockState(bid, "dirty")
	} else {
		e.rows[bid] = &core.Block{ID: bid, WorkspaceID: e.c.ws, DocID: e.doc.ID, ParentID: parent, Rank: rk, Type: b.Type, Props: props,
			Content: b.Content, Plain: md.Plain(b), CreatedBy: e.c.actor.UserID, UpdatedBy: e.c.actor.UserID}
		e.setBlockState(bid, "new")
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
	e.setBlockState(id, "gone")
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
		rk, err := e.rankFor(op, op.Block.ID)
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
		e.setBlockState(op.ID, "dirty")
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
		rk, err := e.rankFor(op, op.ID)
		if err != nil {
			return err
		}
		r.ParentID, r.Rank, r.UpdatedBy = op.Parent, rk, e.c.actor.UserID
		e.setBlockState(op.ID, "dirty")
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
				return nil, nil, alreadyInUse(err, "block id", bid)
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

func (e *editor) liveBlocks() []core.Block {
	var out []core.Block
	for _, r := range e.rows {
		if r.DeletedAt == 0 {
			out = append(out, *r)
		}
	}
	return out
}

// plainText returns the page's text in reading order.
func (e *editor) plainText() string {
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
	walk(BlockTree(e.liveBlocks()))
	return b.String()
}
