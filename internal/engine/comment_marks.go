// Comment threads on words of a page. The words carry the thread's marker
// in the page's text (internal/md, comments.go), so it moves with them as
// people and agents edit. Three things here: the selection a new thread is
// started on, the one rule every edit of a page goes through so that no
// edit drops a marker by mistake (keepMarks), and writing markers when a
// thread is started or deleted.

package engine

import (
	"cmp"
	"maps"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

// takesMarks says whether a block's text can carry markers: a code block
// holds plain text only, and a table's cells are not counted here.
func takesMarks(b *core.Block) bool {
	return b.Type != "codeBlock" && b.Type != "table"
}

// markedPart is the characters of one block's text a thread is put on.
type markedPart struct {
	block      string
	start, end int
}

// selection works out the words a new thread is on: the blocks and the
// characters of each, and the words as the page reads them. Given start
// and end, the words there are checked against the quote; when the page
// has moved on since, the quote is found where it is now, nearest to
// start. Given the quote alone, it is found in the block, and occurrence
// picks one when it is there more than once.
func (c *cx) selection(ed *editor, a commentCreateArgs) ([]markedPart, string, error) {
	first, ok := ed.rows[a.Block]
	if !ok || first.DeletedAt != 0 {
		return nil, "", invalid("block", "block %s is not in this page", a.Block)
	}
	if !takesMarks(first) {
		return nil, "", invalid("block", "words of a code block or a table cannot carry a thread; start it on the block, without quote")
	}
	if strings.TrimSpace(a.Quote) == "" {
		return nil, "", invalid("quote", "give the words the thread is on, as the block reads them")
	}
	text := []rune(md.Plain(md.Block{Type: first.Type, Content: first.Content}))
	quote := []rune(a.Quote)
	if !a.Start.Set {
		if a.EndBlock != "" || a.End.Set {
			return nil, "", invalid("start", "words over several blocks are given by start, end and end_block")
		}
		found := md.Find(first.Content, a.Quote)
		switch {
		case len(found) == 0:
			return nil, "", invalid("quote", "%q is not in that block's text; quote the words exactly as they read", a.Quote)
		case a.Occurrence > len(found) || a.Occurrence < 0:
			return nil, "", invalid("occurrence", "%q is in that block %d times; occurrence is 1 to %d", a.Quote, len(found), len(found))
		case len(found) > 1 && a.Occurrence == 0:
			return nil, "", invalid("occurrence", "%q is in that block %d times; say which with occurrence (1 to %d)", a.Quote, len(found), len(found))
		}
		at := found[max(a.Occurrence, 1)-1]
		return []markedPart{{block: first.ID, start: at, end: at + len(quote)}}, a.Quote, nil
	}
	if !a.End.Set {
		return nil, "", invalid("end", "give where the words end, with start")
	}
	last := cmp.Or(a.EndBlock, first.ID)
	if last == first.ID {
		start, end := a.Start.V, a.End.V
		if start < 0 || start >= end || end > len(text) {
			return nil, "", invalid("start", "start and end are characters of the block's text, 0 to %d, start before end", len(text))
		}
		if string(text[start:end]) != a.Quote {
			found := md.Find(first.Content, a.Quote)
			if len(found) == 0 {
				return nil, "", conflictErr("%q is no longer in that block; the page changed since the words were chosen", a.Quote)
			}
			start = slices.MinFunc(found, func(x, y int) int { return cmp.Compare(abs(x-start), abs(y-start)) })
			end = start + len(quote)
		}
		return []markedPart{{block: first.ID, start: start, end: end}}, a.Quote, nil
	}
	// Several blocks: the end of the first, the blocks between whole, the
	// start of the last, in reading order.
	order := ed.order()
	from, to := slices.Index(order, first.ID), slices.Index(order, last)
	if to < 0 {
		return nil, "", invalid("end_block", "block %s is not in this page", last)
	}
	if to < from {
		return nil, "", invalid("end_block", "the last block comes before the first")
	}
	var parts []markedPart
	var words []string
	for i := from; i <= to; i++ {
		b := ed.rows[order[i]]
		if !takesMarks(b) {
			continue
		}
		text := []rune(md.Plain(md.Block{Type: b.Type, Content: b.Content}))
		start, end := 0, len(text)
		if i == from {
			start = a.Start.V
		}
		if i == to {
			end = a.End.V
		}
		if start < 0 || end > len(text) || start > end {
			return nil, "", invalid("start", "start and end are characters of the first and the last block's text")
		}
		if start < end {
			parts = append(parts, markedPart{block: b.ID, start: start, end: end})
			words = append(words, string(text[start:end]))
		}
	}
	got := strings.Join(words, "\n")
	if strings.Join(strings.Fields(got), " ") != strings.Join(strings.Fields(a.Quote), " ") {
		return nil, "", conflictErr("the words there are no longer %q; the page changed since they were chosen", a.Quote)
	}
	return parts, got, nil
}

func abs(n int) int { return max(n, -n) }

// markSelection puts a new thread's marker on the words of a selection, in
// the editor; the change writes them once the comment is in (writeMarks).
func markSelection(ed *editor, parts []markedPart, thread string) error {
	for _, p := range parts {
		content, ok := md.Mark(ed.rows[p.block].Content, p.start, p.end, thread)
		if !ok {
			return invalid("start", "those characters hold no text a thread can be on (only a mention or a chip)")
		}
		ed.setMarks(p.block, content)
	}
	return nil
}

// writeMarks writes the blocks of a page whose markers alone changed: an
// edit that changes none of the words, so no version is kept, the page's
// and the blocks' last editor stay, and search is left as it is. Editors
// open on the page hear of it as of any edit (doc.edited).
func (c *cx) writeMarks(d core.Doc, ed *editor) error {
	if len(ed.touched) == 0 {
		return nil
	}
	seq := c.tx.NextSeq()
	rows, gone, err := ed.flush(seq)
	if err != nil {
		return err
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"content_seq": seq}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	data := core.EventData{ID: d.ID, Blocks: &rows, Deleted: gone, Changes: map[string]core.FieldChange{"content_seq": {To: seq}}}
	return c.emit(event{seq: seq, typ: "doc.edited", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: data})
}

// rethread gives a deleted thread's marker to the comment that heads the
// thread now (heir), or takes it off the page's words when nobody does.
func (c *cx) rethread(cm core.Comment, heir string) error {
	var d core.Doc
	if there, err := store.Find(c.ctx, c.tx, &d, store.Eq("id", cm.DocID), store.Live); !there {
		return err // a page in the trash keeps its words as they are
	}
	rows, err := LoadBlocks(cxLister{c}, d.ID)
	if err != nil {
		return err
	}
	ed := newEditor(c, d, rows)
	for _, r := range rows {
		if !slices.Contains(md.Threads(r.Content), cm.ID) {
			continue
		}
		ed.setMarks(r.ID, md.RenameThreads(r.Content, func(id string) string {
			if id == cm.ID {
				return heir
			}
			return id
		}))
	}
	return c.writeMarks(d, ed)
}

// keepMarks is the rule every edit of a page goes through before it is
// written, whoever makes it and however. A marker of a thread the edit
// drops while its words are still in the block (an editor that did not
// have it, Markdown without the span) is put back on them; words moved to
// another block by the same edit take it with them. A thread whose words
// are gone stays open: it is detached, on the page as a whole with its
// quote, and the change warns of it. A thread whose marker the edit brings
// back (an undo) is on its words again. Markers of threads that are not
// this page's are taken off. Threads the edit places itself (ed.placed)
// are where it puts them.
func (c *cx) keepMarks(d core.Doc, ed *editor) error {
	live := func(id string) *core.Block {
		if r := ed.rows[id]; r != nil && r.DeletedAt == 0 {
			return r
		}
		return nil
	}
	involved := false
	for _, id := range ed.touched {
		if len(md.Threads(ed.was[id])) > 0 {
			involved = true
		} else if r := live(id); r != nil && len(md.Threads(r.Content)) > 0 {
			involved = true
		}
	}
	if !involved {
		return nil
	}
	threads, err := c.wordThreads(d)
	if err != nil {
		return err
	}

	// Markers of threads that are not this page's go.
	for _, id := range ed.touched {
		if r := live(id); r != nil {
			dropStrangers(ed, r, threads)
		}
	}

	// The threads this edit drops from a block, and the blocks they were in.
	lost := map[string][]string{}
	touchedThreads := map[string]bool{}
	for _, id := range ed.touched {
		var now []string
		if r := live(id); r != nil {
			now = md.Threads(r.Content)
		}
		for _, t := range now {
			touchedThreads[t] = true
		}
		for _, t := range md.Threads(ed.was[id]) {
			if _, ours := threads[t]; ours {
				touchedThreads[t] = true
				if !slices.Contains(now, t) && !slices.Contains(ed.placed, t) {
					lost[t] = append(lost[t], id)
				}
			}
		}
	}

	// Put each back on its words: in the same block, or where this edit
	// moved them, the words it put in another block (the same words that
	// block had already are other words).
	order := ed.order()
	// In the order of the threads' ids, so that what an edit does does not
	// depend on the order Go walks a map in.
	for _, t := range slices.Sorted(maps.Keys(lost)) {
		for _, from := range lost[t] {
			old := ed.was[from]
			if r := live(from); r != nil && takesMarks(r) {
				if content, ok := md.CarryMarks(old, r.Content, t); ok {
					ed.setMarks(from, content)
					continue
				}
			}
			for _, words := range md.Marked(old, t) {
				for _, id := range order {
					r := ed.rows[id]
					if id == from || !slices.Contains(ed.touched, id) || !takesMarks(r) {
						continue
					}
					if at := md.FindAdded(ed.was[id], r.Content, words); len(at) > 0 {
						content, _ := md.Mark(r.Content, at[0], at[0]+utf8.RuneCountInString(words), t)
						ed.setMarks(id, content)
						break
					}
				}
			}
		}
	}

	// Each thread the edit touched is on the first block its words are in,
	// or on the page as a whole when they are nowhere.
	var placed []core.Comment
	for _, t := range slices.Sorted(maps.Keys(touchedThreads)) {
		placed = append(placed, threads[t])
	}
	return c.placeThreads(d, ed, placed)
}

// settleMarks makes a page's threads on words agree with its text after
// the text was set as a whole from elsewhere (a backup), whose markers
// may name threads deleted since and leave out threads started since:
// those markers are taken off, and every thread is where its marker is,
// or detached when the text has none.
func (c *cx) settleMarks(d core.Doc, ed *editor) error {
	threads, err := c.wordThreads(d)
	if err != nil {
		return err
	}
	for _, id := range ed.order() {
		if r := ed.rows[id]; takesMarks(r) {
			dropStrangers(ed, r, threads)
		}
	}
	all := make([]core.Comment, 0, len(threads))
	for _, t := range slices.Sorted(maps.Keys(threads)) {
		all = append(all, threads[t])
	}
	return c.placeThreads(d, ed, all)
}

// wordThreads is a page's live threads on words, by id.
func (c *cx) wordThreads(d core.Doc) (map[string]core.Comment, error) {
	var roots []core.Comment
	if err := c.tx.List(c.ctx, &roots, store.Where(store.Eq("doc_id", d.ID), store.Null("parent_id"), store.NotNull("quote"), store.Live)); err != nil {
		return nil, err
	}
	threads := map[string]core.Comment{}
	for _, cm := range roots {
		threads[cm.ID] = cm
	}
	return threads, nil
}

// dropStrangers takes the markers of threads that are not among threads
// off a block.
func dropStrangers(ed *editor, r *core.Block, threads map[string]core.Comment) {
	if kept := md.RenameThreads(r.Content, func(t string) string { return keepIf(t, threads) }); string(kept) != string(r.Content) {
		ed.setMarks(r.ID, kept)
	}
}

// placeThreads puts each of threads where the page's text (ed) has its
// marker: on the first block, in reading order, that has it, attached
// again if it was detached; or, when no block has it, on the page as a
// whole, detached with its quote, of which the change warns.
func (c *cx) placeThreads(d core.Doc, ed *editor, threads []core.Comment) error {
	order := ed.order()
	for _, cm := range threads {
		on := ""
		for _, id := range order {
			if slices.Contains(md.Threads(ed.rows[id].Content), cm.ID) {
				on = id
				break
			}
		}
		p := newPatch()
		switch {
		case on != "":
			p.put("subject_type", cm.SubjectType, "doc_block")
			p.put("subject_id", cm.SubjectID, on)
			if cm.DetachedAt != 0 {
				p.put("detached_at", cm.DetachedAt, int64(0))
			}
		case cm.DetachedAt == 0:
			p.put("subject_type", cm.SubjectType, "doc")
			p.put("subject_id", cm.SubjectID, d.ID)
			p.put("detached_at", int64(0), c.at)
			stays := "open"
			if cm.ResolvedAt != 0 {
				stays = "resolved"
			}
			c.warn("thread %s was on words this edit took out of the page (%q): it stays %s, on the page as a whole", cm.ID, cm.Quote, stays)
		}
		row, err := c.commentTarget(cm)
		if err != nil {
			return err
		}
		ref := c.ref
		if err := c.save(p, row); err != nil {
			return err
		}
		c.ref = ref // the edit's answer is the page
	}
	return nil
}

// keepIf is a thread's id when it is one of threads, else "" (taken off).
func keepIf(id string, threads map[string]core.Comment) string {
	if _, ok := threads[id]; ok {
		return id
	}
	return ""
}
