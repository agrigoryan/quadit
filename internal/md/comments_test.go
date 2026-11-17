package md

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// paragraph is the inline content of the one paragraph a line of Markdown
// reads as.
func paragraph(t *testing.T, src string) json.RawMessage {
	t.Helper()
	blocks := Parse(src)
	if len(blocks) != 1 {
		t.Fatalf("%q reads as %d blocks, want one", src, len(blocks))
	}
	return blocks[0].Content
}

// marked is the text of content with each run a thread is on in brackets
// that name the threads: "The [a:boss] has".
func marked(t *testing.T, content json.RawMessage) string {
	t.Helper()
	var ins []Inline
	if err := json.Unmarshal(content, &ins); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	var walk func([]Inline)
	walk = func(list []Inline) {
		for _, in := range list {
			if in.Type == "link" {
				walk(in.Content)
				continue
			}
			text := in.Text
			if in.Type != "text" {
				text = in.label()
			}
			if ids := in.Styles.threads(); len(ids) > 0 {
				b.WriteString("[" + strings.Join(ids, ",") + ":" + text + "]")
			} else {
				b.WriteString(text)
			}
		}
	}
	walk(ins)
	return b.String()
}

// TestCommentSpansRoundTrip: the words a comment thread is on are written
// <span data-comment="ID">…</span> for those who read the page with its
// comments, read back as the same marker, and left out of the page as a
// file holds it. Overlapping threads are consecutive spans, each naming
// the threads on its words.
func TestCommentSpansRoundTrip(t *testing.T) {
	for _, src := range []string{
		`The <span data-comment="t1">boss has</span> three phases.`,
		`<span data-comment="t1">One **two** three</span> four`,
		`<span data-comment="t1">see </span><span data-comment="t1 t2">[the plan](https://x.io)</span><span data-comment="t2"> now</span>`,
		"Ask <span data-comment=\"t1\">`code` and *more*</span>.",
	} {
		blocks := Parse(src)
		if got := strings.TrimSuffix(RenderWithComments(blocks), "\n"); got != src {
			t.Errorf("read and written back with comments:\n got %s\nwant %s", got, src)
		}
		plain := strings.TrimSuffix(Render(blocks), "\n")
		if strings.Contains(plain, "<span") {
			t.Errorf("the page as a file keeps a marker: %s", plain)
		}
		if again := strings.TrimSuffix(Render(Parse(plain)), "\n"); again != plain {
			t.Errorf("the page without markers is not stable: %q then %q", plain, again)
		}
	}
	t.Run("a span inside another adds its threads", func(t *testing.T) {
		got := marked(t, paragraph(t, `<span data-comment="a">one <span data-comment="b">two</span></span> three`))
		if want := "[a:one ][a,b:two] three"; got != want {
			t.Errorf("got %s, want %s", got, want)
		}
	})
	t.Run("text that reads as a span is written so it stays text", func(t *testing.T) {
		in := Block{Type: "paragraph", Content: plainjson.Marshal([]Inline{{Type: "text", Text: `type <span data-comment="x">here</span> in`}})}
		md := RenderWithComments([]Block{in})
		if got := Plain(Parse(md)[0]); got != `type <span data-comment="x">here</span> in` {
			t.Errorf("written as %q, read back as %q", md, got)
		}
	})
	t.Run("a closing tag with nothing open is text", func(t *testing.T) {
		if got := Plain(Parse("a </span> b")[0]); got != "a </span> b" {
			t.Errorf("got %q", got)
		}
	})
}

// TestColoredTextIsText: a run with a color (a style whose value is not
// true or false) is read like any other run; it used to make the whole
// block's text unreadable.
func TestColoredTextIsText(t *testing.T) {
	content := json.RawMessage(`[{"type":"text","text":"red","styles":{"textColor":"red","bold":true}},{"type":"text","text":" plain"}]`)
	if got := Plain(Block{Type: "paragraph", Content: content}); got != "red plain" {
		t.Errorf("Plain = %q", got)
	}
	if got := RenderInline(content); got != "**red** plain" {
		t.Errorf("RenderInline = %q", got)
	}
}

// TestMarkPutsAThreadOnCharacters: Mark counts characters of the block's
// text, a mention as its @handle, and puts the thread on the text runs in
// the range, inside links too, beside the threads already there.
func TestMarkPutsAThreadOnCharacters(t *testing.T) {
	content := Mentions(Parse("Ask @ann about [the plan](https://x.io) today."), isMember)[0].Content
	text := []rune(Plain(Block{Type: "paragraph", Content: content}))
	if string(text) != "Ask @ann about the plan today." {
		t.Fatalf("text = %q", string(text))
	}
	got, ok := Mark(content, 0, 8, "a") // "Ask @ann"
	if !ok {
		t.Fatal("not marked")
	}
	got, _ = Mark(got, 15, 23, "b") // "the plan"
	got, _ = Mark(got, 19, 29, "c") // "plan today"
	if want := "[a:Ask ]@ann about [b:the ][b,c:plan][c: today]."; marked(t, got) != want {
		t.Errorf("got %s, want %s", marked(t, got), want)
	}
	if ids := Threads(got); !slices.Equal(ids, []string{"a", "b", "c"}) {
		t.Errorf("Threads = %v", ids)
	}
	if words := Marked(got, "c"); !slices.Equal(words, []string{"plan today"}) {
		t.Errorf("Marked c = %q", words)
	}
	if _, ok := Mark(content, 20, 40, "x"); ok {
		t.Error("a range past the end of the text was marked")
	}
	if _, ok := Mark(json.RawMessage(`{"type":"tableContent","rows":[]}`), 0, 1, "x"); ok {
		t.Error("a table's content was marked")
	}
	again, _ := Mark(got, 0, 3, "a")
	if string(again) != string(got) {
		t.Error("marking words the thread is on already changed the content")
	}
}

// TestRenameThreads: threads are taken off text, or given another id, and
// the runs left alike are one run again.
func TestRenameThreads(t *testing.T) {
	content := paragraph(t, `<span data-comment="a">one </span><span data-comment="a b">two</span> three`)
	got := RenameThreads(content, func(id string) string {
		if id == "a" {
			return ""
		}
		return "c"
	})
	if want := "one [c:two] three"; marked(t, got) != want {
		t.Errorf("got %s, want %s", marked(t, got), want)
	}
	plain := RenameThreads(content, func(string) string { return "" })
	if string(plain) != `[{"type":"text","text":"one two three"}]` {
		t.Errorf("without threads: %s", plain)
	}
}

// TestCarryMarksFollowsTheWords: the words a thread was on, found in the
// block's new text by comparing the two texts character by character, get
// the thread again, with what was typed among them; words that are gone
// take it with them.
func TestCarryMarksFollowsTheWords(t *testing.T) {
	old := paragraph(t, `The <span data-comment="a">boss has three</span> phases.`)
	for _, tc := range []struct {
		name, now, want string
	}{
		{"typed before", "Then the boss has three phases.", "Then the [a:boss has three] phases."},
		{"typed inside", "The boss now has three phases.", "The [a:boss now has three] phases."},
		{"typed after", "The boss has three or four phases.", "The [a:boss has three] or four phases."},
		{"part taken out", "The boss three phases.", "The [a:boss three] phases."},
		{"rewritten around", "In the end, boss has three, they say.", "In the end, [a:boss has three], they say."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := CarryMarks(old, paragraph(t, tc.now), "a")
			if !ok || marked(t, got) != tc.want {
				t.Errorf("got %s (%v), want %s", marked(t, got), ok, tc.want)
			}
		})
	}
	for name, now := range map[string]string{
		"words gone":                "The phases.",
		"other words with a letter": "The boss is gone.",
	} {
		t.Run(name, func(t *testing.T) {
			if got, ok := CarryMarks(old, paragraph(t, now), "a"); ok {
				t.Errorf("marked %s on text without the words", marked(t, got))
			}
		})
	}
}

// TestTakeMarksPlacesThreadsAsWritten: the threads named take the places
// the other content gives them, of the same text; the rest stay.
func TestTakeMarksPlacesThreadsAsWritten(t *testing.T) {
	old := paragraph(t, `<span data-comment="a">One</span> two <span data-comment="b">three</span>`)
	written := paragraph(t, `One <span data-comment="a">two three</span>`)
	got := TakeMarks(old, written, []string{"a"})
	if want := "One [a:two ][a,b:three]"; marked(t, got) != want {
		t.Errorf("got %s, want %s", marked(t, got), want)
	}
}

// TestFindWords: where words are in a block's text, counted in characters.
func TestFindWords(t *testing.T) {
	content := paragraph(t, "Café, the café, a CAFÉ.")
	if got := Find(content, "café"); !slices.Equal(got, []int{10}) {
		t.Errorf("Find = %v", got)
	}
	if got := Find(content, "é"); !slices.Equal(got, []int{3, 13}) {
		t.Errorf("Find = %v", got)
	}
	if got := Find(content, ""); got != nil {
		t.Errorf("Find of nothing = %v", got)
	}
}

// TestFindAddedWords: of the places words are in a block's new text, only
// those an edit put there count; words the block had already do not.
func TestFindAddedWords(t *testing.T) {
	was := paragraph(t, "Then three phases run.")
	for _, tc := range []struct {
		now  string
		want []int
	}{
		{"Then three phases run. three phases", []int{23}},
		{"Then three phases run fast.", nil},
		{"three phases: then three phases run.", []int{0}},
	} {
		if got := FindAdded(was, paragraph(t, tc.now), "three phases"); !slices.Equal(got, tc.want) {
			t.Errorf("in %q: %v, want %v", tc.now, got, tc.want)
		}
	}
	if got := FindAdded(nil, was, "three phases"); !slices.Equal(got, []int{5}) {
		t.Errorf("in a new block: %v, want every place", got)
	}
}

// TestCarryMarksAtTheEdges: what CarryMarks does with words that are
// short, repeated, not Latin, around a mention, or moved within the block.
// A thread is put back only when most of its words are still there, kept
// in stretches of three characters or more (all of them, for words shorter
// than three); words written the same twice are told apart by the text
// around them, so taking one out of two alike may leave the thread on the
// other, as the two texts cannot say which went.
func TestCarryMarksAtTheEdges(t *testing.T) {
	mentioned := func(src string) json.RawMessage {
		return Mentions(Parse(src), isMember)[0].Content
	}
	for _, tc := range []struct {
		name     string
		old, now json.RawMessage
		want     string // "" for words gone: no marker put back
	}{
		{"one letter kept", paragraph(t, `<span data-comment="a">a</span> cat`), paragraph(t, "So a cat"), "So [a:a] cat"},
		{"one letter changed", paragraph(t, `<span data-comment="a">a</span> cat`), paragraph(t, "A cat"), ""},
		{"an emoji kept", paragraph(t, `I <span data-comment="a">👍🏽</span> it`), paragraph(t, "Yes, I 👍🏽 it"), "Yes, I [a:👍🏽] it"},
		{"an emoji changed", paragraph(t, `I <span data-comment="a">👍🏽</span> it`), paragraph(t, "I 👍 it"), ""},
		{"Japanese kept", paragraph(t, `東京<span data-comment="a">タワーは</span>高い`), paragraph(t, "東京タワーはとても高い"), "東京[a:タワーは]とても高い"},
		{"two Japanese characters, one gone", paragraph(t, `<span data-comment="a">東京</span>は高い`), paragraph(t, "京は高い"), ""},
		{"a repeated word taken out", paragraph(t, `I said no, <span data-comment="a">no</span>.`), paragraph(t, "I said no."), ""},
		{"one of two alike taken out", paragraph(t, `I said <span data-comment="a">never</span>, never.`), paragraph(t, "I said never."), "I said [a:never]."},
		{"the words taken out, the same later on kept", paragraph(t, `The <span data-comment="a">phases</span> are good. Many phases`), paragraph(t, "The are good! Many phases"), ""},
		{"a mention among the words", mentioned(`Ask <span data-comment="a">@ann about it</span> now`), mentioned("Please ask @ann about it today"), "Please ask @ann[a: about it] today"},
		{"moved to the end of the block", paragraph(t, `<span data-comment="a">alpha beta gamma</span> delta`), paragraph(t, "delta alpha beta gamma"), "delta [a:alpha beta gamma]"},
		{"moved to the start of the block", paragraph(t, `delta <span data-comment="a">alpha beta gamma</span>`), paragraph(t, "alpha beta gamma delta"), "[a:alpha beta gamma] delta"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := CarryMarks(tc.old, tc.now, "a")
			if tc.want == "" {
				if ok {
					t.Errorf("put back as %s, want the words gone", marked(t, got))
				}
				return
			}
			if !ok || marked(t, got) != tc.want {
				t.Errorf("got %s (%v), want %s", marked(t, got), ok, tc.want)
			}
		})
	}
}
