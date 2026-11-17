package engine_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// blocksOf is a page's live blocks in reading order.
func (w *world) blocksOf(page string) []core.Block {
	w.t.Helper()
	var blocks []core.Block
	if err := w.db().List(context.Background(), &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", page), store.Live}, Order: "rank"}); err != nil {
		w.t.Fatal(err)
	}
	return blocks
}

// comment is a comment as stored.
func (w *world) comment(id string) core.Comment {
	w.t.Helper()
	var cm core.Comment
	if err := w.db().Get(context.Background(), &cm, store.Eq("id", id)); err != nil {
		w.t.Fatal(err)
	}
	return cm
}

// markedOn is the words a thread is on in each of a page's blocks, as
// "block: words", in reading order.
func (w *world) markedOn(page, thread string) []string {
	w.t.Helper()
	var out []string
	for _, b := range w.blocksOf(page) {
		for _, words := range md.Marked(b.Content, thread) {
			out = append(out, b.ID+": "+words)
		}
	}
	return out
}

// plainContent is inline content of one run of plain text.
func plainContent(text string) json.RawMessage {
	raw, _ := json.Marshal([]md.Inline{{Type: "text", Text: text}})
	return raw
}

// TestAThreadOnWordsMarksThem: comment.create given the words of a block
// starts a thread on them: in the same change the words get the thread's
// marker, the comment keeps them as its quote, and the page's editors hear
// of the block. The words are found by themselves, or checked against
// where the caller says they are, and may run over several blocks.
func TestAThreadOnWordsMarksThem(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		page := w.do(w.owner.ID, "doc.create", M{"title": "Boss", "markdown": "The boss has three phases.\n\nThen it runs, and a cat and a cat.\n"}).Ref
		first, second := w.blocksOf(page)[0].ID, w.blocksOf(page)[1].ID

		t.Run("found by the words", func(t *testing.T) {
			res := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": first, "quote": "three phases", "body": "Four?"})
			var types []string
			for _, ev := range res.Events {
				types = append(types, ev.Type)
			}
			if !slices.Equal(types, []string{"comment.created", "doc.edited"}) {
				t.Errorf("events %v, want the comment and the block", types)
			}
			cm := w.comment(res.Ref)
			if cm.Quote != "three phases" || cm.SubjectType != "doc_block" || cm.SubjectID != first {
				t.Errorf("comment %+v, want on block %s quoting the words", cm, first)
			}
			if got := w.markedOn(page, cm.ID); !slices.Equal(got, []string{first + ": three phases"}) {
				t.Errorf("marked %v", got)
			}
		})
		t.Run("checked where the caller says they are", func(t *testing.T) {
			cm := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": first, "start": 4, "end": 8, "quote": "boss", "body": "Big?"}).Ref
			if got := w.markedOn(page, cm); !slices.Equal(got, []string{first + ": boss"}) {
				t.Errorf("marked %v", got)
			}
			// The page moved on since the words were chosen: they are found where they are now.
			moved := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": second, "start": 0, "end": 4, "quote": "runs", "body": "Where?"}).Ref
			if got := w.markedOn(page, moved); !slices.Equal(got, []string{second + ": runs"}) {
				t.Errorf("marked %v", got)
			}
			w.refused(engine.CodeConflict, w.owner.ID, "comment.create", M{"doc": page, "block": first, "start": 0, "end": 3, "quote": "dragon", "body": "?"})
		})
		t.Run("words there more than once need which", func(t *testing.T) {
			if ee := w.refused(engine.CodeInvalid, w.owner.ID, "comment.create", M{"doc": page, "block": second, "quote": "a cat", "body": "?"}); ee.Field != "occurrence" || !strings.Contains(ee.Message, "2 times") {
				t.Errorf("refusal %+v, want one naming occurrence", ee)
			}
			cm := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": second, "quote": "a cat", "occurrence": 2, "body": "Which cat?"}).Ref
			text := []rune(md.Plain(md.Block{Type: "paragraph", Content: w.blocksOf(page)[1].Content}))
			if ranges := md.Find(w.blocksOf(page)[1].Content, "a cat"); len(ranges) != 2 || string(text[ranges[1]:ranges[1]+5]) != "a cat" {
				t.Fatalf("found %v", ranges)
			}
			if got := w.markedOn(page, cm); !slices.Equal(got, []string{second + ": a cat"}) {
				t.Errorf("marked %v", got)
			}
			if ee := w.refused(engine.CodeInvalid, w.owner.ID, "comment.create", M{"doc": page, "block": second, "quote": "a dog", "body": "?"}); ee.Field != "quote" {
				t.Errorf("refusal %+v, want one naming quote", ee)
			}
		})
		t.Run("over several blocks", func(t *testing.T) {
			cm := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": first, "start": 19, "end_block": second, "end": 4, "quote": "phases.\nThen", "body": "Join them?"}).Ref
			if got := w.markedOn(page, cm); !slices.Equal(got, []string{first + ": phases.", second + ": Then"}) {
				t.Errorf("marked %v", got)
			}
			if c := w.comment(cm); c.SubjectID != first || c.Quote != "phases.\nThen" {
				t.Errorf("comment %+v", c)
			}
		})
		t.Run("by an agent that may not edit the page", func(t *testing.T) {
			reviewer := w.do(w.owner.ID, "agent.create", M{"name": "Reviewer", "handle": "reviewer", "scope": M{"needs_approval": []string{"doc.edit", "doc.write"}}}).Ref
			w.refused(engine.CodeNeedsApproval, reviewer, "doc.write", M{"doc": page, "markdown": "Gone."})
			cm := w.do(reviewer, "comment.create", M{"doc": page, "block": first, "quote": "The", "body": "Article?"}).Ref
			if got := w.markedOn(page, cm); !slices.Equal(got, []string{first + ": The"}) {
				t.Errorf("marked %v", got)
			}
		})
		t.Run("a reply or a code block takes no words", func(t *testing.T) {
			root := w.do(w.owner.ID, "comment.create", M{"doc": page, "body": "On the page."}).Ref
			w.refused(engine.CodeInvalid, w.owner.ID, "comment.create", M{"parent": root, "block": first, "quote": "boss", "body": "?"})
			code := w.do(w.owner.ID, "doc.create", M{"title": "Code", "markdown": "```\nhp = 300\n```\n"}).Ref
			w.refused(engine.CodeInvalid, w.owner.ID, "comment.create", M{"doc": code, "block": w.blocksOf(code)[0].ID, "quote": "hp", "body": "?"})
		})
	})
}

// TestAnEditKeepsTheMarkers: whoever edits a page, and however (the
// editor's block saves, Markdown, an undo), the words a thread is on keep
// its marker while they are there. Words gone take the thread off them: it
// stays open, on the page as a whole with its quote, and the edit says so.
// An edit that brings the marker back puts the thread on its words again.
func TestAnEditKeepsTheMarkers(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		start := func(t *testing.T) (page, block, thread string) {
			t.Helper()
			page = w.do(w.owner.ID, "doc.create", M{"title": "Boss", "markdown": "The boss has three phases.\n\nThen it runs.\n"}).Ref
			block = w.blocksOf(page)[0].ID
			thread = w.do(w.owner.ID, "comment.create", M{"doc": page, "block": block, "quote": "three phases", "body": "Four?"}).Ref
			return page, block, thread
		}
		save := func(t *testing.T, page, block string, content json.RawMessage) []string {
			t.Helper()
			return w.do(w.owner.ID, "doc.edit", M{"doc": page, "ops": []M{{"op": "update", "id": block, "content": content}}}).Warnings
		}

		t.Run("a save without the marker keeps it on the words still there", func(t *testing.T) {
			page, block, thread := start(t)
			save(t, page, block, plainContent("The big boss has three phases!"))
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{block + ": three phases"}) {
				t.Errorf("marked %v", got)
			}
		})
		t.Run("typing inside the words keeps them marked", func(t *testing.T) {
			page, block, thread := start(t)
			save(t, page, block, plainContent("The boss has three short phases."))
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{block + ": three short phases"}) {
				t.Errorf("marked %v", got)
			}
		})
		t.Run("a resolved thread keeps its marker too", func(t *testing.T) {
			page, block, thread := start(t)
			w.do(w.owner.ID, "comment.update", M{"id": thread, "resolved": true})
			save(t, page, block, plainContent("The boss has three phases."))
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{block + ": three phases"}) {
				t.Errorf("marked %v", got)
			}
		})
		t.Run("words taken out detach the thread, and an undo puts it back", func(t *testing.T) {
			page, block, thread := start(t)
			marked := w.blocksOf(page)[0].Content
			warnings := save(t, page, block, plainContent("The boss is gone."))
			cm := w.comment(thread)
			if cm.DetachedAt == 0 || cm.SubjectType != "doc" || cm.SubjectID != page || cm.ResolvedAt != 0 || cm.Quote != "three phases" {
				t.Errorf("comment %+v, want it open on the page with its quote", cm)
			}
			if len(warnings) != 1 || !strings.Contains(warnings[0], thread) || !strings.Contains(warnings[0], "three phases") {
				t.Errorf("warnings %q, want one naming the thread and its words", warnings)
			}
			save(t, page, block, marked)
			cm = w.comment(thread)
			if cm.DetachedAt != 0 || cm.SubjectType != "doc_block" || cm.SubjectID != block {
				t.Errorf("comment %+v, want it on its block again", cm)
			}
		})
		t.Run("a block taken out detaches its threads", func(t *testing.T) {
			page, block, thread := start(t)
			w.do(w.owner.ID, "doc.edit", M{"doc": page, "ops": []M{{"op": "delete", "id": block}}})
			if cm := w.comment(thread); cm.DetachedAt == 0 || cm.SubjectType != "doc" {
				t.Errorf("comment %+v, want it detached", cm)
			}
		})
		t.Run("words moved to another block take the marker with them", func(t *testing.T) {
			page, block, thread := start(t)
			other := w.blocksOf(page)[1].ID
			w.do(w.owner.ID, "doc.edit", M{"doc": page, "ops": []M{
				{"op": "update", "id": block, "content": plainContent("The boss has.")},
				{"op": "update", "id": other, "content": plainContent("Then it runs three phases.")},
			}})
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{other + ": three phases"}) {
				t.Errorf("marked %v", got)
			}
			if cm := w.comment(thread); cm.SubjectID != other || cm.DetachedAt != 0 {
				t.Errorf("comment %+v, want it on the block the words went to", cm)
			}
		})
		t.Run("Markdown written back keeps the marker on words it keeps", func(t *testing.T) {
			page, block, thread := start(t)
			w.do(w.owner.ID, "doc.write", M{"doc": page, "markdown": "The boss has three phases.\n\nThen it runs and hides.\n"})
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{block + ": three phases"}) {
				t.Errorf("an unchanged paragraph: marked %v", got)
			}
			w.do(w.owner.ID, "doc.write", M{"doc": page, "markdown": "Now the boss has three phases, sadly.\n\nThen it runs and hides.\n"})
			now := w.blocksOf(page)[0].ID
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{now + ": three phases"}) {
				t.Errorf("a rewritten paragraph: marked %v", got)
			}
			if cm := w.comment(thread); cm.SubjectID != now || cm.DetachedAt != 0 {
				t.Errorf("comment %+v, want it on the new paragraph", cm)
			}
		})
		t.Run("a span written places the marker, and one of no thread here is dropped", func(t *testing.T) {
			page, block, thread := start(t)
			written := `The boss has <span data-comment="` + thread + `">three</span> <span data-comment="nobody">phases</span>.` + "\n\nThen it runs.\n"
			w.do(w.owner.ID, "doc.write", M{"doc": page, "markdown": written})
			if got := w.markedOn(page, thread); !slices.Equal(got, []string{block + ": three"}) {
				t.Errorf("marked %v", got)
			}
			if got := w.markedOn(page, "nobody"); len(got) != 0 {
				t.Errorf("an unknown thread is on %v", got)
			}
		})
		t.Run("deleting the thread takes its marker off, or hands it to the thread's next head", func(t *testing.T) {
			page, block, thread := start(t)
			w.do(w.owner.ID, "comment.delete", M{"id": thread})
			if got := w.markedOn(page, thread); len(got) != 0 {
				t.Errorf("a deleted thread is still on %v", got)
			}
			second := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": block, "quote": "boss", "body": "Big?"}).Ref
			reply := w.do(w.owner.ID, "comment.create", M{"parent": second, "body": "Bigger."}).Ref
			w.do(w.owner.ID, "comment.delete", M{"id": second})
			if got := w.markedOn(page, reply); !slices.Equal(got, []string{block + ": boss"}) {
				t.Errorf("the reply heading the thread now is on %v", got)
			}
			if cm := w.comment(reply); cm.Quote != "boss" || cm.SubjectID != block {
				t.Errorf("the new head %+v, want the thread's words", cm)
			}
		})
	})
}
