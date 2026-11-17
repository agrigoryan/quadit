// Writing blocks and inline content back out as Markdown.

package md

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Render turns blocks back into Markdown, as a file holds a page: the
// words comment threads are on are plain words.
func Render(blocks []Block) string {
	var b strings.Builder
	render(&b, blocks, "", false)
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// RenderWithComments turns blocks into Markdown as agents read and write a
// page: the words each comment thread is on are written
// <span data-comment="THREAD_ID">words</span>, words several threads are
// on name them all, space-separated, and where threads overlap the spans
// follow each other, each naming the threads on its words.
func RenderWithComments(blocks []Block) string {
	var b strings.Builder
	render(&b, blocks, "", true)
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// isList says whether a block of type t is a list item.
func isList(t string) bool {
	return t == "bulletListItem" || t == "numberedListItem" || t == "checkListItem"
}

// render writes blocks out, each line under indent, with the comment spans
// when comments says so.
func render(b *strings.Builder, blocks []Block, indent string, comments bool) {
	number := 0
	for i, bl := range blocks {
		if bl.Type == "numberedListItem" {
			number++
		} else {
			number = 0
		}
		// A blank line between blocks, except between the items of a list.
		inList := i > 0 && isList(bl.Type) && isList(blocks[i-1].Type)
		if i > 0 && !inList {
			b.WriteString("\n")
		}
		renderBlock(b, bl, number, indent, comments)
		if len(bl.Children) > 0 {
			child := indent + "  "
			if bl.Type == "numberedListItem" {
				child = indent + "   "
			}
			if !isList(bl.Type) {
				b.WriteString("\n")
			}
			render(b, bl.Children, child, comments)
		}
	}
}

// renderBlock writes one block out, without its children; number is its
// place in a numbered list.
func renderBlock(b *strings.Builder, bl Block, number int, indent string, comments bool) {
	text := renderContent(bl.Content, comments)
	cont := strings.ReplaceAll(text, "\n", "\n"+indent+"  ")
	switch bl.Type {
	case "heading":
		b.WriteString(indent + strings.Repeat("#", headingLevel(bl)) + " " + strings.ReplaceAll(text, "\n", " ") + "\n")
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
		b.WriteString(indent + mediaLink(bl) + "\n")
	case "table":
		renderTable(b, bl.Content, indent, comments)
	default:
		b.WriteString(indent + strings.ReplaceAll(text, "\n", "\n"+indent) + "\n")
	}
}

// headingLevel is a heading's level, 1 to 6. The level is a number in
// JSON, or an int in blocks made here.
func headingLevel(bl Block) int {
	level := 1
	if f, ok := bl.Props["level"].(float64); ok {
		level = int(f)
	} else if n, ok := bl.Props["level"].(int); ok {
		level = n
	}
	return max(1, min(level, 6))
}

// mediaLink is a picture or video as ![caption](url), or a file or sound
// as a plain link to it.
func mediaLink(bl Block) string {
	u, _ := bl.Props["url"].(string)
	caption, _ := bl.Props["caption"].(string)
	if caption == "" {
		caption, _ = bl.Props["name"].(string)
	}
	if bl.Type == "file" || bl.Type == "audio" {
		return "[" + caption + "](" + u + ")"
	}
	return "![" + caption + "](" + u + ")"
}

// renderTable writes a table out, with a line of dashes under its first
// row; content that is not a table is left out.
func renderTable(b *strings.Builder, content json.RawMessage, indent string, comments bool) {
	var t Table
	if json.Unmarshal(content, &t) != nil {
		return
	}
	for i, r := range t.Rows {
		b.WriteString(indent + "|")
		for _, c := range r.Cells {
			b.WriteString(" " + strings.ReplaceAll(strings.ReplaceAll(renderContent(cellContent(c), comments), "|", "\\|"), "\n", " ") + " |")
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

// RenderInline turns inline content into Markdown text, without comment
// spans.
func RenderInline(content json.RawMessage) string {
	return renderContent(content, false)
}

// renderContent turns inline content into Markdown text, with the comment
// spans when comments says so.
func renderContent(content json.RawMessage, comments bool) string {
	var ins []Inline
	if len(content) == 0 || json.Unmarshal(content, &ins) != nil {
		var s string
		if json.Unmarshal(content, &s) == nil {
			return s
		}
		return ""
	}
	if !comments {
		return renderInlines(ins, false)
	}
	return renderSpans(ins, "")
}

// renderSpans writes inline content out with a comment span around each
// stretch of it that is on other threads than outer, the threads a span
// around it names already. A mention or a chip carries no threads of its
// own: between two runs on the same threads it is inside their span.
func renderSpans(ins []Inline, outer string) string {
	value := make([]string, len(ins))
	for i, in := range ins {
		value[i] = threadsOn(in)
	}
	for i, in := range ins {
		if in.Type != "text" && in.Type != "link" && i > 0 && i+1 < len(ins) && value[i-1] == value[i+1] {
			value[i] = value[i-1]
		}
	}
	var b strings.Builder
	for i := 0; i < len(ins); {
		end := i + 1
		for end < len(ins) && value[end] == value[i] {
			end++
		}
		var part strings.Builder
		for _, in := range ins[i:end] {
			if in.Type == "link" {
				writeLink(&part, in, renderSpans(in.Content, value[i]))
			} else {
				part.WriteString(renderInlines([]Inline{in}, true))
			}
		}
		if value[i] == outer {
			b.WriteString(part.String())
		} else {
			b.WriteString(spanOpen + value[i] + `">` + part.String() + spanClose)
		}
		i = end
	}
	return b.String()
}

// threadsOn is the threads a run of text is on, as a span names them; a
// link's when every run in it is on the same ones. "" for none.
func threadsOn(in Inline) string {
	if in.Type != "link" {
		return strings.Join(in.Styles.threads(), " ")
	}
	if len(in.Content) == 0 {
		return ""
	}
	first := threadsOn(in.Content[0])
	for _, inner := range in.Content[1:] {
		if threadsOn(inner) != first {
			return ""
		}
	}
	return first
}

// writeLink writes a link around its text as Markdown: a link whose text is
// its address is the bare address.
func writeLink(b *strings.Builder, in Inline, inner string) {
	if inner == in.Href {
		b.WriteString(in.Href)
	} else {
		b.WriteString("[" + inner + "](" + in.Href + ")")
	}
}

// renderInlines writes inline content out: links, marks around the text
// they cover, and the label of a mention or chip. Text that reads as a
// comment span is kept text where spans are read (comments).
func renderInlines(ins []Inline, comments bool) string {
	var b strings.Builder
	for _, in := range ins {
		if in.Type == "link" {
			writeLink(&b, in, renderInlines(in.Content, comments))
			continue
		}
		if in.Type != "text" && in.Text == "" {
			b.WriteString(in.label())
			continue
		}
		t := in.Text
		// Markers go around the text, not around its outer spaces; code
		// keeps its spaces inside its backticks.
		lead := t[:len(t)-len(strings.TrimLeft(t, " \n"))]
		trail := t[len(strings.TrimRight(t, " \n")):]
		core := strings.TrimSpace(t)
		switch {
		case in.Styles.On("code"):
			lead, trail, core = "", "", "`"+t+"`"
		case core == "":
			b.WriteString(t)
			continue
		default:
			core = escape(core, comments)
		}
		if in.Styles.On("strike") {
			core = "~~" + core + "~~"
		}
		if in.Styles.On("italic") {
			core = "*" + core + "*"
		}
		if in.Styles.On("bold") {
			core = "**" + core + "**"
		}
		b.WriteString(lead + core + trail)
	}
	return b.String()
}

// escape protects the characters that would read as markup, and only where
// they would: a star between spaces, a bracket that starts no link or a <
// that starts no comment span (or any, where spans are not read: not
// comments) is left as it is, so plain text stays plain.
func escape(s string, comments bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '*':
			before := i == 0 || s[i-1] == ' ' || s[i-1] == '*'
			after := i+1 == len(s) || s[i+1] == ' ' || s[i+1] == '*'
			alone := before && after // a star between spaces is left as it is
			if !alone {
				b.WriteByte('\\')
			}
		case '`':
			b.WriteByte('\\')
		case '[':
			if strings.Contains(s[i:], "](") {
				b.WriteByte('\\')
			}
		case '<':
			if comments && (strings.HasPrefix(s[i:], spanOpen) || strings.HasPrefix(s[i:], spanClose)) {
				b.WriteByte('\\')
			}
		}
		b.WriteByte(c)
	}
	return b.String()
}
