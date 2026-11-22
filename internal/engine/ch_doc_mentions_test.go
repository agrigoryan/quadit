package engine_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestMarkdownMentionsInAPageAreMentions: @handle of a member in Markdown
// written to a page is stored as the editor stores a typed mention, and
// does what one does: the page references the member, who is told. Writing
// the same Markdown again changes no block.
func TestMarkdownMentionsInAPageAreMentions(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		bea := w.agent("bea")
		page := w.do(w.owner.ID, "doc.create", M{"title": "Plan", "markdown": "Ask @bea, not @nobody.\n"}).Ref
		blocks := func() []core.Block {
			var bs []core.Block
			if err := w.db().List(context.Background(), &bs, store.Where(store.Eq("doc_id", page), store.Live)); err != nil {
				t.Fatal(err)
			}
			return bs
		}
		first := blocks()
		var content []struct {
			Type  string            `json:"type"`
			Text  string            `json:"text"`
			Props map[string]string `json:"props"`
		}
		if len(first) != 1 || json.Unmarshal(first[0].Content, &content) != nil {
			t.Fatalf("the page holds %+v", first)
		}
		var got []string
		for _, in := range content {
			got = append(got, in.Type+":"+in.Text+in.Props["handle"])
		}
		if strings.Join(got, "|") != "text:Ask |mention:bea|text:, not @nobody." {
			t.Fatalf("the page holds %s, want a mention of @bea and @nobody as text", first[0].Content)
		}
		var refs []core.Ref
		if err := w.db().List(context.Background(), &refs, store.Where(store.Eq("from_scope_id", page), store.Eq("to_id", bea))); err != nil || len(refs) != 1 {
			t.Fatalf("the page does not reference @bea: %v %+v", err, refs)
		}
		var notes []core.Notification
		if err := w.db().List(context.Background(), &notes, store.Where(store.Eq("user_id", bea), store.Eq("doc_id", page))); err != nil || len(notes) != 1 {
			t.Fatalf("@bea is not told of the mention: %v %+v", err, notes)
		}

		w.do(w.owner.ID, "doc.write", M{"doc": page, "markdown": "Ask @bea, not @nobody.\n"})
		again := blocks()
		if len(again) != 1 || again[0].ID != first[0].ID || again[0].UpdatedSeq != first[0].UpdatedSeq {
			t.Fatalf("writing the same Markdown changed the page: %+v, was %+v", again, first)
		}
	})
}
