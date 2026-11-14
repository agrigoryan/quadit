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
		if got := renderInlines(ParseInline(in)); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}
