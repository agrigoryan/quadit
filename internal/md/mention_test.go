package md

import (
	"encoding/json"
	"strings"
	"testing"
)

// isMember stands for the workspace's members: ann and bot are, nobody is not.
func isMember(handle string) bool { return handle == "ann" || handle == "bot" }

// inlines is a block's inline content.
func inlines(t *testing.T, b Block) []Inline {
	t.Helper()
	var ins []Inline
	if err := json.Unmarshal(b.Content, &ins); err != nil {
		t.Fatal(err)
	}
	return ins
}

// TestMentionsOfMembersBecomeMentions: @handle of a member, in a page's
// plain text (a table cell's too), is a mention as the editor stores one
// ({type: mention, props: {handle}}); a handle of nobody, an address, marked
// text (bold, code), a code block and a link's text stay text.
func TestMentionsOfMembersBecomeMentions(t *testing.T) {
	blocks := Mentions(Parse("Ask @ann, **and @bot**, not @nobody or me@ann.com.\n\n`@ann` [@ann](https://example.com)\n\n```\n@ann\n```\n\n| who | why |\n| --- | --- |\n| @bot | builds |\n"), isMember)
	got := inlines(t, blocks[0])
	var kinds []string
	for _, in := range got {
		kinds = append(kinds, in.Type+":"+in.Text+in.label())
	}
	want := "text:Ask  mention:@ann text:,  text:and @bot text:, not @nobody or me@ann.com."
	if strings.Join(kinds, " ") != want {
		t.Fatalf("got  %s\nwant %s", strings.Join(kinds, " "), want)
	}
	for _, in := range inlines(t, blocks[1]) {
		if in.Type == "mention" {
			t.Fatalf("a code span or a link's text became a mention: %+v", inlines(t, blocks[1]))
		}
	}
	if strings.Contains(string(blocks[2].Content), `"mention"`) {
		t.Fatalf("a code block became a mention: %s", blocks[2].Content)
	}
	if !strings.Contains(string(blocks[3].Content), `"type":"mention"`) {
		t.Fatalf("a table cell's mention stays text: %s", blocks[3].Content)
	}
}

// TestMentionsGoBackAsHandles: a page with mentions is written as Markdown
// with each as @handle, so reading and writing it again changes nothing.
func TestMentionsGoBackAsHandles(t *testing.T) {
	src := "Ask @ann, **and @bot**, not @nobody.\n\n- [ ] @bot builds it\n\n| who | why |\n| --- | --- |\n| @bot | builds |\n"
	out := Render(Mentions(Parse(src), isMember))
	if out != Render(Parse(src)) {
		t.Fatalf("a mention does not go back as its handle:\n%s", out)
	}
	if again := Render(Mentions(Parse(out), isMember)); again != out {
		t.Fatalf("not stable:\n--- first\n%s\n--- second\n%s", out, again)
	}
}
