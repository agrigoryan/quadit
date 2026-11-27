// Comment threads as an agent reads them: a page's threads, after its text
// or alone, and where in its thread a comment an inbox item names sits.

package server

import (
	"cmp"
	"context"
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

// threadView is one thread of comments on a page: its first comment and
// the replies to it, and what it is on: words of the page, a block, or the
// page as a whole (no Block). A thread on words whose words an edit took
// out of the page is on the page as a whole, Detached, its words quoted.
type threadView struct {
	ID       string `json:"id"` // the first comment's: replies and resolving go through it
	Block    string `json:"block,omitempty"`
	Quote    string `json:"quote,omitempty"` // the thread's words, or the block's text
	Words    bool   `json:"on_words,omitempty"`
	Detached bool   `json:"detached,omitempty"`
	Removed  bool   `json:"block_removed,omitempty"`
	Resolved bool   `json:"resolved,omitempty"`
	// Comments are the first one and then the replies, oldest first.
	Comments []threadComment `json:"comments"`
}

// threadComment is one comment of a thread.
type threadComment struct {
	ID     string `json:"id"`
	By     string `json:"by"`
	At     string `json:"at"`
	Body   string `json:"body"`
	Edited bool   `json:"edited,omitempty"`
}

// pageThreads are the comment threads on a page, oldest first. A reply
// whose first comment was deleted went with it.
func (who *viewer) pageThreads(ctx context.Context, page core.Doc) ([]threadView, error) {
	var comments []core.Comment
	if err := who.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID), store.Live}, Order: "created_seq"}); err != nil {
		return nil, err
	}
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	var blockIDs []string
	for _, cm := range comments {
		if cm.ParentID == "" && cm.SubjectType == "doc_block" {
			blockIDs = append(blockIDs, cm.SubjectID)
		}
	}
	// The blocks taken out of the page since are read too: their text says
	// what the thread was about.
	var blocks []core.Block
	if len(blockIDs) > 0 {
		if err := who.db.List(ctx, &blocks, store.Where(store.Eq("doc_id", page.ID), store.In("id", blockIDs))); err != nil {
			return nil, err
		}
	}
	blockByID := map[string]core.Block{}
	for _, b := range blocks {
		blockByID[b.ID] = b
	}
	threads := []threadView{}
	at := map[string]int{} // a thread's place in threads, by its id
	for _, cm := range comments {
		line := threadComment{ID: cm.ID, By: names.handle(cm.AuthorID), At: formatTime(cm.CreatedAt), Body: cm.Body, Edited: cm.EditedAt != 0}
		if cm.ParentID != "" {
			if i, ok := at[cm.ParentID]; ok {
				threads[i].Comments = append(threads[i].Comments, line)
			}
			continue
		}
		th := threadView{ID: cm.ID, Resolved: cm.ResolvedAt != 0, Comments: []threadComment{line}}
		switch {
		case cm.DetachedAt != 0:
			th.Detached, th.Quote = true, oneLine(cm.Quote, quoteChars)
		case cm.SubjectType == "doc_block":
			b, there := blockByID[cm.SubjectID]
			th.Block, th.Quote, th.Removed = cm.SubjectID, oneLine(b.Plain, quoteChars), !there || b.DeletedAt != 0
			if cm.Quote != "" {
				// The words as they read now: what was typed among them since is theirs.
				th.Words, th.Quote = true, oneLine(cmp.Or(strings.Join(md.Marked(b.Content, cm.ID), " … "), cm.Quote), quoteChars)
			}
		}
		at[cm.ID] = len(threads)
		threads = append(threads, th)
	}
	return threads, nil
}

// quoteChars is as much of a block's text as a thread quotes.
const quoteChars = 200

// threadsText writes threads under a heading that counts them. The
// resolved ones are written only when withResolved says so; otherwise the
// heading says how many were left out. No threads at all write nothing.
func threadsText(threads []threadView, withResolved bool) string {
	open, resolved := 0, 0
	for _, th := range threads {
		if th.Resolved {
			resolved++
		} else {
			open++
		}
	}
	if len(threads) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "--- comments: %s", counted(open, "open thread"))
	switch {
	case resolved > 0 && withResolved:
		fmt.Fprintf(&b, ", %d resolved\n", resolved)
	case resolved > 0:
		fmt.Fprintf(&b, "; %d resolved (resolved=1 shows them)\n", resolved)
	default:
		b.WriteString("\n")
	}
	for _, th := range threads {
		if th.Resolved && !withResolved {
			continue
		}
		b.WriteString("thread " + th.ID)
		if th.Resolved {
			b.WriteString(" (resolved)")
		}
		switch {
		case th.Detached:
			b.WriteString(" on the page, its words taken out of it:")
		case th.Block == "":
			b.WriteString(" on the page")
		case th.Removed:
			b.WriteString(" on removed block " + th.Block)
		case th.Words:
			b.WriteString(" on words of block " + th.Block)
		default:
			b.WriteString(" on block " + th.Block)
		}
		if th.Quote != "" {
			fmt.Fprintf(&b, " %q", th.Quote)
		}
		b.WriteString("\n")
		for i, cm := range th.Comments {
			indent := "  "
			if i > 0 {
				indent = "    " // a reply, under the comment it answers
			}
			edited := ""
			if cm.Edited {
				edited = " (edited)"
			}
			// A body's later lines stand further in than any reply's first.
			body := strings.ReplaceAll(strings.TrimRight(cm.Body, "\n"), "\n", "\n"+indent+"    ")
			fmt.Fprintf(&b, "%s%s %s%s: %s\n", indent, cm.By, cm.At, edited, body)
		}
	}
	return b.String()
}

// counted is n things in words: "no open thread", "1 open thread", "2
// open threads".
func counted(n int, thing string) string {
	switch n {
	case 0:
		return "no " + thing
	case 1:
		return "1 " + thing
	}
	return fmt.Sprintf("%d %ss", n, thing)
}

// handleListPageComments returns a page's comment threads alone: as text,
// the open ones unless resolved=1; as JSON, all of them.
func (s *Server) handleListPageComments(x *c) error {
	page, err := x.docByID(x.ctx(), x.r.PathValue("id"))
	if err != nil {
		return err
	}
	threads, err := x.pageThreads(x.ctx(), page)
	if err != nil {
		return err
	}
	if !x.wantText() {
		return x.ok(map[string]any{"threads": threads})
	}
	text := threadsText(threads, truthyParam(x.r.URL.Query(), "resolved"))
	if text == "" {
		text = "no comments\n"
	}
	return x.text(x.namePages(x.ctx(), text))
}

// noteRefs are the ids an inbox item gives whoever acts on it: the page it
// is on, and for a comment, the comment, its thread (the id a reply or a
// resolve goes through) and the words or the block the thread is on.
type noteRefs struct {
	Page    string `json:"page,omitempty"`
	Comment string `json:"comment,omitempty"`
	Thread  string `json:"thread,omitempty"`
	Quote   string `json:"quote,omitempty"`
}

// refsOf finds an inbox item's refs. A comment deleted since, or one that
// cannot be read, is left out: the item is told without it.
func (who *viewer) refsOf(ctx context.Context, n core.Notification) noteRefs {
	refs := noteRefs{Page: n.DocID}
	var cm core.Comment
	if n.EntityType != "comment" || !who.foundForLine(ctx, &cm, store.Eq("id", n.EntityID), store.Live) {
		return refs
	}
	refs.Comment, refs.Thread = cm.ID, cm.ID
	first := cm
	if cm.ParentID != "" {
		refs.Thread = cm.ParentID
		if !who.foundForLine(ctx, &first, store.Eq("id", cm.ParentID)) {
			return refs
		}
	}
	// Only a block of the thread's own page is quoted: one of another page,
	// which only a row written before such threads were refused can name,
	// may be of a page the reader cannot see.
	var b core.Block
	switch {
	case first.Quote != "":
		refs.Quote = oneLine(first.Quote, quoteChars)
	case first.SubjectType == "doc_block" && who.foundForLine(ctx, &b, store.Eq("id", first.SubjectID), store.Eq("doc_id", first.DocID)):
		refs.Quote = oneLine(b.Plain, quoteChars)
	}
	return refs
}

// text is the refs in brackets, to follow an item's line; nothing when
// there are none.
func (refs noteRefs) text() string {
	var parts []string
	if refs.Page != "" {
		parts = append(parts, "page "+refs.Page)
	}
	if refs.Comment != "" {
		parts = append(parts, "comment "+refs.Comment, "thread "+refs.Thread)
	}
	if refs.Quote != "" {
		parts = append(parts, fmt.Sprintf("on %q", refs.Quote))
	}
	if len(parts) == 0 {
		return ""
	}
	return "  (" + strings.Join(parts, ", ") + ")"
}
