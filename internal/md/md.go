// Package md converts between Markdown and the editor's blocks. Agents and
// the command-line tool read and write pages as Markdown; the editor works
// in blocks; the server converts, so both see the same page.
//
// A block is {id, type, props, content, children}, the shape the BlockNote
// editor uses. Inline content is a list of {type:"text", text, styles} and
// {type:"link", href, content}.
package md

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Block is one block of a page with its nested blocks.
type Block struct {
	ID       string          `json:"id,omitempty"`
	Type     string          `json:"type"`
	Props    map[string]any  `json:"props,omitempty"`
	Content  json.RawMessage `json:"content,omitempty"`
	Children []Block         `json:"children,omitempty"`
}

// Inline is one run of text or a link.
type Inline struct {
	Type    string          `json:"type"`
	Text    string          `json:"text,omitempty"`
	Styles  map[string]bool `json:"styles,omitempty"`
	Href    string          `json:"href,omitempty"`
	Content []Inline        `json:"content,omitempty"`
	// Props belong to inline things that are not text: a mention carries
	// the member's handle, a task chip its key.
	Props map[string]any `json:"props,omitempty"`
}

// label is the text an inline thing that is not text stands for.
func (in Inline) label() string {
	if h, _ := in.Props["handle"].(string); h != "" {
		return "@" + strings.TrimPrefix(h, "@")
	}
	if k, _ := in.Props["key"].(string); k != "" {
		return k
	}
	if d, _ := in.Props["doc"].(string); d != "" {
		return "doc:" + d
	}
	return ""
}

// Table is the content of a table block.
type Table struct {
	Type string     `json:"type"`
	Rows []TableRow `json:"rows"`
}

type TableRow struct {
	Cells []json.RawMessage `json:"cells"`
}

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

func inline(text string) json.RawMessage {
	raw, _ := json.Marshal(ParseInline(text))
	return raw
}

// Parse turns Markdown into blocks.
func Parse(src string) []Block {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	p := &parser{lines: lines}
	return p.blocks(0)
}

type parser struct {
	lines []string
	pos   int
}

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

// blocks reads blocks until a line indented less than min.
func (p *parser) blocks(min int) []Block {
	var out []Block
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		if strings.TrimSpace(line) == "" {
			p.pos++
			continue
		}
		if indentOf(line) < min {
			return out
		}
		out = append(out, p.block(min))
	}
	return out
}

func (p *parser) block(min int) Block {
	line := p.lines[p.pos]
	trimmed := strings.TrimSpace(line)
	if m := fenceRE.FindStringSubmatch(line); m != nil {
		return p.code(m[1], m[2])
	}
	if m := headingRE.FindStringSubmatch(trimmed); m != nil {
		p.pos++
		return Block{Type: "heading", Props: map[string]any{"level": len(m[1])}, Content: inline(m[2])}
	}
	if ruleRE.MatchString(line) && !bulletRE.MatchString(line) {
		p.pos++
		return Block{Type: "divider"}
	}
	if m := imageRE.FindStringSubmatch(trimmed); m != nil {
		p.pos++
		props := map[string]any{"url": m[2]}
		if m[1] != "" {
			props["caption"] = m[1]
		}
		typ := "image"
		if low := strings.ToLower(m[2]); strings.HasSuffix(low, ".mp4") || strings.HasSuffix(low, ".webm") || strings.HasSuffix(low, ".mov") {
			typ = "video"
		}
		return Block{Type: typ, Props: props}
	}
	if strings.HasPrefix(trimmed, ">") {
		var parts []string
		for p.pos < len(p.lines) && strings.HasPrefix(strings.TrimSpace(p.lines[p.pos]), ">") {
			parts = append(parts, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(p.lines[p.pos]), ">")))
			p.pos++
		}
		return Block{Type: "quote", Content: inline(strings.Join(parts, "\n"))}
	}
	if strings.Contains(line, "|") && p.pos+1 < len(p.lines) && tableSep.MatchString(p.lines[p.pos+1]) && strings.Contains(p.lines[p.pos+1], "-") {
		return p.table()
	}
	if m := bulletRE.FindStringSubmatch(line); m != nil {
		return p.item(len(m[1]), m[3], "bulletListItem")
	}
	if m := numberRE.FindStringSubmatch(line); m != nil {
		return p.item(len(m[1]), m[3], "numberedListItem")
	}
	// A paragraph runs until a blank line or the start of another block.
	var parts []string
	for p.pos < len(p.lines) {
		l := p.lines[p.pos]
		t := strings.TrimSpace(l)
		if t == "" || (len(parts) > 0 && (headingRE.MatchString(t) || fenceRE.MatchString(l) || bulletRE.MatchString(l) || numberRE.MatchString(l) ||
			strings.HasPrefix(t, ">") || ruleRE.MatchString(l) || imageRE.MatchString(t))) {
			break
		}
		parts = append(parts, t)
		p.pos++
	}
	return Block{Type: "paragraph", Content: inline(strings.Join(parts, "\n"))}
}

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
	b := Block{Type: "codeBlock", Content: mustJSON([]Inline{{Type: "text", Text: strings.Join(body, "\n")}})}
	if lang != "" {
		b.Props = map[string]any{"language": lang}
	}
	return b
}

func mustJSON(v any) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
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
	b.Content = inline(text)
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

func (p *parser) table() Block {
	t := Table{Type: "tableContent"}
	row := func(line string) {
		var r TableRow
		for _, c := range splitRow(line) {
			r.Cells = append(r.Cells, inline(c))
		}
		t.Rows = append(t.Rows, r)
	}
	row(p.lines[p.pos])
	p.pos += 2 // the header and the line of dashes
	for p.pos < len(p.lines) && strings.Contains(p.lines[p.pos], "|") && strings.TrimSpace(p.lines[p.pos]) != "" {
		row(p.lines[p.pos])
		p.pos++
	}
	return Block{Type: "table", Content: mustJSON(t)}
}

// ParseInline turns one run of Markdown text into inline content.
func ParseInline(s string) []Inline {
	var out []Inline
	var buf strings.Builder
	styles := map[string]bool{}
	flush := func() {
		if buf.Len() == 0 {
			return
		}
		in := Inline{Type: "text", Text: buf.String()}
		if len(styles) > 0 {
			in.Styles = map[string]bool{}
			for k := range styles {
				in.Styles[k] = true
			}
		}
		out = append(out, in)
		buf.Reset()
	}
	toggle := func(name string) {
		flush()
		if styles[name] {
			delete(styles, name)
		} else {
			styles[name] = true
		}
	}
	for i := 0; i < len(s); {
		rest := s[i:]
		switch {
		case s[i] == '\\' && i+1 < len(s) && strings.ContainsRune("\\`*_{}[]()#+-.!|~>", rune(s[i+1])):
			buf.WriteByte(s[i+1])
			i += 2
		case s[i] == '`':
			end := strings.IndexByte(rest[1:], '`')
			if end < 0 {
				buf.WriteByte('`')
				i++
				continue
			}
			flush()
			in := Inline{Type: "text", Text: rest[1 : 1+end], Styles: map[string]bool{"code": true}}
			out = append(out, in)
			i += end + 2
		case strings.HasPrefix(rest, "**") || strings.HasPrefix(rest, "__"):
			if closes(s, i, rest[:2], styles["bold"]) {
				toggle("bold")
				i += 2
			} else {
				buf.WriteString(rest[:2])
				i += 2
			}
		case strings.HasPrefix(rest, "~~"):
			if closes(s, i, "~~", styles["strike"]) {
				toggle("strike")
			} else {
				buf.WriteString("~~")
			}
			i += 2
		case (s[i] == '*' || s[i] == '_') && emphasisAt(s, i, styles["italic"]):
			toggle("italic")
			i++
		case s[i] == '[':
			if text, href, n := linkAt(rest); n > 0 {
				flush()
				inner := ParseInline(text)
				for k := range inner {
					for st := range styles {
						if inner[k].Styles == nil {
							inner[k].Styles = map[string]bool{}
						}
						inner[k].Styles[st] = true
					}
				}
				out = append(out, Inline{Type: "link", Href: href, Content: inner})
				i += n
			} else {
				buf.WriteByte('[')
				i++
			}
		case strings.HasPrefix(rest, "http://") || strings.HasPrefix(rest, "https://"):
			end := strings.IndexAny(rest, " \n\t<>")
			if end < 0 {
				end = len(rest)
			}
			for end > 0 && strings.ContainsRune(".,;:!?)", rune(rest[end-1])) {
				end--
			}
			flush()
			out = append(out, Inline{Type: "link", Href: rest[:end], Content: []Inline{{Type: "text", Text: rest[:end]}}})
			i += end
		default:
			buf.WriteByte(s[i])
			i++
		}
	}
	flush()
	if out == nil {
		out = []Inline{}
	}
	return out
}

// closes reports whether a marker at i opens a span that is closed later,
// or closes one that is open.
func closes(s string, i int, marker string, open bool) bool {
	if open {
		return true
	}
	rest := s[i+len(marker):]
	return rest != "" && rest[0] != ' ' && strings.Contains(rest, marker)
}

// emphasisAt reports whether a single * or _ at i is emphasis rather than a
// literal character, such as the underscores in snake_case.
func emphasisAt(s string, i int, open bool) bool {
	c := s[i]
	if c == '_' {
		prevWord := i > 0 && isWord(s[i-1])
		nextWord := i+1 < len(s) && isWord(s[i+1])
		if prevWord && nextWord {
			return false
		}
	}
	if open {
		return i > 0 && s[i-1] != ' '
	}
	if i+1 >= len(s) || s[i+1] == ' ' || s[i+1] == c {
		return false
	}
	return strings.IndexByte(s[i+1:], c) >= 0
}

func isWord(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// linkAt reads "[text](href)" at the start of s.
func linkAt(s string) (text, href string, n int) {
	depth := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				if i+1 >= len(s) || s[i+1] != '(' {
					return "", "", 0
				}
				end := strings.IndexByte(s[i+2:], ')')
				if end < 0 {
					return "", "", 0
				}
				href = strings.TrimSpace(s[i+2 : i+2+end])
				if sp := strings.IndexByte(href, ' '); sp > 0 {
					href = href[:sp] // drop a title
				}
				return s[1:i], href, i + 3 + end
			}
		}
	}
	return "", "", 0
}

// ---- blocks to Markdown ----

// Render turns blocks back into Markdown.
func Render(blocks []Block) string {
	var b strings.Builder
	render(&b, blocks, "")
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func isList(t string) bool {
	return t == "bulletListItem" || t == "numberedListItem" || t == "checkListItem"
}

func render(b *strings.Builder, blocks []Block, indent string) {
	number := 0
	for i, bl := range blocks {
		if bl.Type == "numberedListItem" {
			number++
		} else {
			number = 0
		}
		// A blank line between blocks, except between the items of a list.
		if i > 0 && !(isList(bl.Type) && isList(blocks[i-1].Type)) {
			b.WriteString("\n")
		}
		text := RenderInline(bl.Content)
		cont := strings.ReplaceAll(text, "\n", "\n"+indent+"  ")
		switch bl.Type {
		case "heading":
			level := 1
			if f, ok := bl.Props["level"].(float64); ok {
				level = int(f)
			} else if n, ok := bl.Props["level"].(int); ok {
				level = n
			}
			b.WriteString(indent + strings.Repeat("#", max(1, min(level, 6))) + " " + strings.ReplaceAll(text, "\n", " ") + "\n")
		case "bulletListItem":
			b.WriteString(indent + "- " + cont + "\n")
		case "numberedListItem":
			b.WriteString(indent + strconv.Itoa(number) + ". " + cont + "\n")
		case "checkListItem":
			mark := " "
			if c, _ := bl.Props["checked"].(bool); c {
				mark = "x"
			}
			b.WriteString(indent + "- [" + mark + "] " + cont + "\n")
		case "codeBlock":
			lang, _ := bl.Props["language"].(string)
			b.WriteString(indent + "```" + lang + "\n" + indent + strings.ReplaceAll(Plain(bl), "\n", "\n"+indent) + "\n" + indent + "```\n")
		case "quote":
			b.WriteString(indent + "> " + strings.ReplaceAll(text, "\n", "\n"+indent+"> ") + "\n")
		case "divider":
			b.WriteString(indent + "---\n")
		case "image", "video", "file", "audio":
			u, _ := bl.Props["url"].(string)
			caption, _ := bl.Props["caption"].(string)
			if caption == "" {
				caption, _ = bl.Props["name"].(string)
			}
			if bl.Type == "file" || bl.Type == "audio" {
				b.WriteString(indent + "[" + caption + "](" + u + ")\n")
			} else {
				b.WriteString(indent + "![" + caption + "](" + u + ")\n")
			}
		case "table":
			renderTable(b, bl.Content, indent)
		default:
			b.WriteString(indent + strings.ReplaceAll(text, "\n", "\n"+indent) + "\n")
		}
		if len(bl.Children) > 0 {
			child := indent + "  "
			if bl.Type == "numberedListItem" {
				child = indent + "   "
			}
			if !isList(bl.Type) {
				b.WriteString("\n")
			}
			render(b, bl.Children, child)
		}
	}
}

func renderTable(b *strings.Builder, content json.RawMessage, indent string) {
	var t Table
	if json.Unmarshal(content, &t) != nil {
		return
	}
	for i, r := range t.Rows {
		b.WriteString(indent + "|")
		for _, c := range r.Cells {
			b.WriteString(" " + strings.ReplaceAll(strings.ReplaceAll(RenderInline(cellContent(c)), "|", "\\|"), "\n", " ") + " |")
		}
		b.WriteString("\n")
		if i == 0 {
			b.WriteString(indent + "|" + strings.Repeat(" --- |", len(r.Cells)) + "\n")
		}
	}
}

// cellContent returns a cell's inline content. A cell is a list of inline
// content, or an object holding one.
func cellContent(c json.RawMessage) json.RawMessage {
	var obj struct {
		Content json.RawMessage `json:"content"`
	}
	if len(c) > 0 && c[0] == '{' && json.Unmarshal(c, &obj) == nil {
		return obj.Content
	}
	return c
}

// RenderInline turns inline content into Markdown text.
func RenderInline(content json.RawMessage) string {
	var ins []Inline
	if len(content) == 0 || json.Unmarshal(content, &ins) != nil {
		var s string
		if json.Unmarshal(content, &s) == nil {
			return s
		}
		return ""
	}
	return renderInlines(ins)
}

func renderInlines(ins []Inline) string {
	var b strings.Builder
	for _, in := range ins {
		if in.Type == "link" {
			inner := renderInlines(in.Content)
			if inner == in.Href {
				b.WriteString(in.Href)
			} else {
				b.WriteString("[" + inner + "](" + in.Href + ")")
			}
			continue
		}
		if in.Type != "text" && in.Text == "" {
			b.WriteString(in.label())
			continue
		}
		t := in.Text
		if in.Styles["code"] {
			b.WriteString("`" + t + "`")
			continue
		}
		// Markers go around the text, not around its outer spaces.
		lead := t[:len(t)-len(strings.TrimLeft(t, " \n"))]
		trail := t[len(strings.TrimRight(t, " \n")):]
		core := strings.TrimSpace(t)
		if core == "" {
			b.WriteString(t)
			continue
		}
		core = escape(core)
		if in.Styles["strike"] {
			core = "~~" + core + "~~"
		}
		if in.Styles["italic"] {
			core = "*" + core + "*"
		}
		if in.Styles["bold"] {
			core = "**" + core + "**"
		}
		b.WriteString(lead + core + trail)
	}
	return b.String()
}

// escape protects the characters that would read as markup, and only where
// they would: a star between spaces or a bracket that starts no link is left
// as it is, so plain text stays plain.
func escape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '*':
			before := i == 0 || s[i-1] == ' ' || s[i-1] == '*'
			after := i+1 == len(s) || s[i+1] == ' ' || s[i+1] == '*'
			if !(before && after) {
				b.WriteByte('\\')
			}
		case '`':
			b.WriteByte('\\')
		case '[':
			if strings.Contains(s[i:], "](") {
				b.WriteByte('\\')
			}
		}
		b.WriteByte(c)
	}
	return b.String()
}

// Plain returns a block's text with no markup, for search and previews.
func Plain(b Block) string {
	if b.Type == "table" {
		var t Table
		if json.Unmarshal(b.Content, &t) != nil {
			return ""
		}
		var parts []string
		for _, r := range t.Rows {
			for _, c := range r.Cells {
				parts = append(parts, plainInline(cellContent(c)))
			}
		}
		return strings.Join(parts, " ")
	}
	return plainInline(b.Content)
}

func plainInline(content json.RawMessage) string {
	var ins []Inline
	if len(content) == 0 || json.Unmarshal(content, &ins) != nil {
		var s string
		json.Unmarshal(content, &s)
		return s
	}
	var b strings.Builder
	var walk func([]Inline)
	walk = func(list []Inline) {
		for _, in := range list {
			b.WriteString(in.Text)
			if in.Type != "text" && in.Type != "link" {
				b.WriteString(in.label())
			}
			walk(in.Content)
		}
	}
	walk(ins)
	return b.String()
}
