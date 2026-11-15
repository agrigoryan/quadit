// Writing blocks and inline content back out as Markdown.

package md

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Render turns blocks back into Markdown.
func Render(blocks []Block) string {
	var b strings.Builder
	render(&b, blocks, "")
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// isList says whether a block of type t is a list item.
func isList(t string) bool {
	return t == "bulletListItem" || t == "numberedListItem" || t == "checkListItem"
}

// render writes blocks out, each line under indent.
func render(b *strings.Builder, blocks []Block, indent string) {
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
		renderBlock(b, bl, number, indent)
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

// renderBlock writes one block out, without its children; number is its
// place in a numbered list.
func renderBlock(b *strings.Builder, bl Block, number int, indent string) {
	text := RenderInline(bl.Content)
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
		renderTable(b, bl.Content, indent)
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

// renderInlines writes inline content out: links, marks around the text
// they cover, and the label of a mention or chip.
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
		}
		b.WriteByte(c)
	}
	return b.String()
}
