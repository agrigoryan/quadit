// Reading Markdown into blocks: headings, lists, quotes, code, tables,
// pictures and paragraphs.

package md

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// The patterns of the lines that start a block.
var (
	headingRE = regexp.MustCompile(`^(#{1,6})\s+(.*?)\s*#*\s*$`)
	bulletRE  = regexp.MustCompile(`^(\s*)([-*+])\s+(.*)$`)
	numberRE  = regexp.MustCompile(`^(\s*)(\d+)[.)]\s+(.*)$`)
	checkRE   = regexp.MustCompile(`^\[( |x|X)\]\s+(.*)$`)
	fenceRE   = regexp.MustCompile("^\\s*(```+|~~~+)\\s*([A-Za-z0-9_+#.-]*)\\s*$")
	ruleRE    = regexp.MustCompile(`^\s*([-*_])(\s*[-*_]){2,}\s*$`)
	imageRE   = regexp.MustCompile(`^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$`)
	tableSep  = regexp.MustCompile(`^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$`)
)

// inline is the inline content of a run of Markdown, as JSON.
func (p *parser) inline(text string) json.RawMessage {
	return plainjson.Marshal(parseInline(text, p.comments))
}

// Parse turns Markdown into blocks, as a file holds a page (Render): what
// reads as a comment span is text.
func Parse(src string) []Block {
	return parse(src, false)
}

// ParseWithComments turns Markdown into blocks as agents write a page
// (RenderWithComments): the words in a comment span carry its threads.
func ParseWithComments(src string) []Block {
	return parse(src, true)
}

func parse(src string, comments bool) []Block {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	p := &parser{lines: lines, comments: comments}
	return p.blocks(0)
}

// parser reads one page of Markdown, a line at a time; comments says
// whether it reads comment spans.
type parser struct {
	lines    []string
	pos      int
	comments bool
}

// indentOf is how far a line is indented, a tab counting four spaces.
func indentOf(s string) int {
	n := 0
	for _, r := range s {
		switch r {
		case ' ':
			n++
		case '\t':
			n += 4
		default:
			return n
		}
	}
	return n
}

// blocks reads blocks until a line indented less than minIndent.
func (p *parser) blocks(minIndent int) []Block {
	var out []Block
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		if strings.TrimSpace(line) == "" {
			p.pos++
			continue
		}
		if indentOf(line) < minIndent {
			return out
		}
		out = append(out, p.block())
	}
	return out
}

// block reads the block that starts at the current line.
func (p *parser) block() Block {
	line := p.lines[p.pos]
	trimmed := strings.TrimSpace(line)
	if m := fenceRE.FindStringSubmatch(line); m != nil {
		return p.code(m[1], m[2])
	}
	if m := headingRE.FindStringSubmatch(trimmed); m != nil {
		p.pos++
		return Block{Type: "heading", Props: map[string]any{"level": len(m[1])}, Content: p.inline(m[2])}
	}
	if ruleRE.MatchString(line) && !bulletRE.MatchString(line) {
		p.pos++
		return Block{Type: "divider"}
	}
	if m := imageRE.FindStringSubmatch(trimmed); m != nil {
		// A picture or video on a line of its own.
		p.pos++
		return media(m[1], m[2])
	}
	if strings.HasPrefix(trimmed, ">") {
		return p.quote()
	}
	if p.tableStarts(line) {
		return p.table()
	}
	if m := bulletRE.FindStringSubmatch(line); m != nil {
		return p.item(len(m[1]), m[3], "bulletListItem")
	}
	if m := numberRE.FindStringSubmatch(line); m != nil {
		return p.item(len(m[1]), m[3], "numberedListItem")
	}
	return p.paragraph()
}

// media is a picture, or a video when the address names a video file.
func media(caption, url string) Block {
	props := map[string]any{"url": url}
	if caption != "" {
		props["caption"] = caption
	}
	typ := "image"
	if low := strings.ToLower(url); strings.HasSuffix(low, ".mp4") || strings.HasSuffix(low, ".webm") || strings.HasSuffix(low, ".mov") {
		typ = "video"
	}
	return Block{Type: typ, Props: props}
}

// quote reads the lines of a quote, each starting with >.
func (p *parser) quote() Block {
	var parts []string
	for p.pos < len(p.lines) && strings.HasPrefix(strings.TrimSpace(p.lines[p.pos]), ">") {
		parts = append(parts, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(p.lines[p.pos]), ">")))
		p.pos++
	}
	return Block{Type: "quote", Content: p.inline(strings.Join(parts, "\n"))}
}

// tableStarts says whether line is a table's header: it has a | and the
// line under it is a line of dashes.
func (p *parser) tableStarts(line string) bool {
	return strings.Contains(line, "|") && p.pos+1 < len(p.lines) && tableSep.MatchString(p.lines[p.pos+1]) && strings.Contains(p.lines[p.pos+1], "-")
}

// paragraph reads a paragraph: it runs until a blank line or the start of
// another block.
func (p *parser) paragraph() Block {
	var parts []string
	for p.pos < len(p.lines) {
		l := p.lines[p.pos]
		t := strings.TrimSpace(l)
		if t == "" || (len(parts) > 0 && startsBlock(l, t)) {
			break
		}
		parts = append(parts, t)
		p.pos++
	}
	return Block{Type: "paragraph", Content: p.inline(strings.Join(parts, "\n"))}
}

// startsBlock says whether a line (and its trimmed form) starts a block
// that ends a paragraph before it.
func startsBlock(l, t string) bool {
	return headingRE.MatchString(t) || fenceRE.MatchString(l) || bulletRE.MatchString(l) || numberRE.MatchString(l) ||
		strings.HasPrefix(t, ">") || ruleRE.MatchString(l) || imageRE.MatchString(t)
}

// code reads a fenced code block, up to its closing fence.
func (p *parser) code(fence, lang string) Block {
	p.pos++
	var body []string
	for p.pos < len(p.lines) {
		l := p.lines[p.pos]
		p.pos++
		if strings.HasPrefix(strings.TrimSpace(l), fence[:3]) && strings.Trim(strings.TrimSpace(l), fence[:1]) == "" {
			break
		}
		body = append(body, l)
	}
	b := Block{Type: "codeBlock", Content: plainjson.Marshal([]Inline{{Type: "text", Text: strings.Join(body, "\n")}})}
	if lang != "" {
		b.Props = map[string]any{"language": lang}
	}
	return b
}

// item reads one list item and the blocks nested under it.
func (p *parser) item(indent int, text, typ string) Block {
	p.pos++
	b := Block{Type: typ}
	if m := checkRE.FindStringSubmatch(text); m != nil && typ == "bulletListItem" {
		b.Type, text = "checkListItem", m[2]
		b.Props = map[string]any{"checked": m[1] != " "}
	}
	// Lines indented under the item that are not list items continue it.
	for p.pos < len(p.lines) {
		l := p.lines[p.pos]
		if strings.TrimSpace(l) == "" || indentOf(l) <= indent || bulletRE.MatchString(l) || numberRE.MatchString(l) || fenceRE.MatchString(l) {
			break
		}
		text += "\n" + strings.TrimSpace(l)
		p.pos++
	}
	b.Content = p.inline(text)
	// Skip blank lines only if something more deeply indented follows.
	save := p.pos
	for p.pos < len(p.lines) && strings.TrimSpace(p.lines[p.pos]) == "" {
		p.pos++
	}
	if p.pos < len(p.lines) && indentOf(p.lines[p.pos]) > indent {
		b.Children = p.blocks(indent + 1)
	} else {
		p.pos = save
	}
	return b
}

// splitRow splits a table row into its cells; \| is a | inside a cell.
func splitRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	var cells []string
	var cur strings.Builder
	for i := 0; i < len(line); i++ {
		switch {
		case line[i] == '\\' && i+1 < len(line) && line[i+1] == '|':
			cur.WriteByte('|')
			i++
		case line[i] == '|':
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
		default:
			cur.WriteByte(line[i])
		}
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

// table reads a table: its header, the line of dashes, and the rows.
func (p *parser) table() Block {
	t := Table{Type: "tableContent"}
	row := func(line string) {
		var r TableRow
		for _, c := range splitRow(line) {
			r.Cells = append(r.Cells, p.inline(c))
		}
		t.Rows = append(t.Rows, r)
	}
	row(p.lines[p.pos])
	p.pos += 2 // the header and the line of dashes
	for p.pos < len(p.lines) && strings.Contains(p.lines[p.pos], "|") && strings.TrimSpace(p.lines[p.pos]) != "" {
		row(p.lines[p.pos])
		p.pos++
	}
	return Block{Type: "table", Content: plainjson.Marshal(t)}
}
