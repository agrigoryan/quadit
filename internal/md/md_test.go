package md

import (
	"strings"
	"testing"
)

const sample = `# Boss fight

The boss has **three** phases, each *harder* than the last. See [the plan](https://example.com/plan) and ` + "`boss.gd`" + `.

## Phases

1. Laser sweep
2. Summon drones
   - two at a time
   - never more than six
3. Enrage

- [x] sprite
- [ ] music with snake_case_name

> Keep it readable at 1x.

` + "```gdscript\nfunc _ready():\n    hp = 300\n```" + `

| Phase | HP |
| --- | --- |
| One | 100 |
| Two \| late | 200 |

![the boss](https://example.com/boss.png)

---

Done.
`

func TestRoundTrip(t *testing.T) {
	blocks := Parse(sample)
	var types []string
	for _, b := range blocks {
		types = append(types, b.Type)
	}
	want := "heading paragraph heading numberedListItem numberedListItem numberedListItem checkListItem checkListItem quote codeBlock table image divider paragraph"
	if got := strings.Join(types, " "); got != want {
		t.Fatalf("blocks:\n got %s\nwant %s", got, want)
	}
	if len(blocks[4].Children) != 2 || blocks[4].Children[0].Type != "bulletListItem" {
		t.Fatalf("nested list = %+v", blocks[4].Children)
	}
	if blocks[6].Props["checked"] != true || blocks[7].Props["checked"] != false {
		t.Fatalf("checklist = %+v %+v", blocks[6].Props, blocks[7].Props)
	}
	out := Render(blocks)
	// Rendering what was parsed and parsing it again gives the same page.
	if again := Render(Parse(out)); again != out {
		t.Fatalf("not stable:\n--- first\n%s\n--- second\n%s", out, again)
	}
	for _, keep := range []string{"**three**", "*harder*", "[the plan](https://example.com/plan)", "`boss.gd`", "snake_case_name", "   - two at a time",
		"- [x] sprite", "> Keep it readable", "```gdscript", "    hp = 300", "| Two \\| late | 200 |", "![the boss](https://example.com/boss.png)", "---"} {
		if !strings.Contains(out, keep) {
			t.Errorf("lost %q in:\n%s", keep, out)
		}
	}
	if p := Plain(blocks[1]); !strings.Contains(p, "three phases") || strings.Contains(p, "*") {
		t.Fatalf("plain = %q", p)
	}
}

func TestInlineEdges(t *testing.T) {
	for in, want := range map[string]string{
		"2 * 3 * 4":               "2 * 3 * 4",
		"a_b_c and __init__":      "a_b_c and **init**",
		"see https://x.io/a, ok":  "see https://x.io/a, ok",
		"**bold *both* end**":     "**bold** ***both*** **end**",
		"unclosed ** star":        "unclosed ** star",
		"[not a link] here":       "[not a link] here",
		"literal [x](y) kept":     "literal [x](y) kept",
		"a*b":                     "a\\*b",
		"~~gone~~ and `code *x*`": "~~gone~~ and `code *x*`",
	} {
		if got := renderInlines(ParseInline(in), false); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

// TestMarksAroundCodeRoundTrip: code inside bold, italic, strike or a link
// keeps every mark around it, read and written back, as in
// "**bold `code` bold**".
func TestMarksAroundCodeRoundTrip(t *testing.T) {
	for in, want := range map[string]string{
		"**bold `code` bold**":            "**bold** **`code`** **bold**",
		"*it `code` it*":                  "*it* *`code`* *it*",
		"~~gone `code` gone~~":            "~~gone~~ ~~`code`~~ ~~gone~~",
		"***both `code`***":               "***both*** ***`code`***",
		"[see `code`](https://x.io)":      "[see `code`](https://x.io)",
		"**[bold `code`](https://x.io)**": "[**bold** **`code`**](https://x.io)",
	} {
		parsed := ParseInline(in)
		got := renderInlines(parsed, false)
		if got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
		if a, b := styled(parsed), styled(ParseInline(got)); a != b {
			t.Errorf("%q read back from %q is\n %s\nwant\n %s", in, got, b, a)
		}
		if !strings.Contains(styled(parsed), "code") {
			t.Errorf("%q lost its code: %s", in, styled(parsed))
		}
	}
}

// styled is each character of inline content with the marks on it and the
// link it is in, so two readings can be compared whatever their runs.
func styled(ins []Inline) string {
	var b strings.Builder
	var walk func(ins []Inline, href string)
	walk = func(ins []Inline, href string) {
		for _, in := range ins {
			if in.Type == "link" {
				walk(in.Content, in.Href)
				continue
			}
			var marks []string
			for _, m := range []string{"bold", "italic", "strike", "code"} {
				if in.Styles.On(m) {
					marks = append(marks, m)
				}
			}
			for _, r := range in.Text {
				if r == ' ' {
					b.WriteString(" ")
					continue
				}
				b.WriteString(string(r) + "(" + strings.Join(marks, "+") + href + ")")
			}
		}
	}
	walk(ins, "")
	return b.String()
}
