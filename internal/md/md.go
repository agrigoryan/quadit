// Package md converts between Markdown and the editor's blocks. Agents and
// the command-line tool read and write pages as Markdown; the editor works
// in blocks; the server converts, so both see the same page.
//
// A block is {id, type, props, content, children}, the shape the BlockNote
// editor uses. Inline content is a list of {type:"text", text, styles} and
// {type:"link", href, content}.
//
// How the package is laid out:
//
//	md.go       the types: blocks, inline content, tables; and Plain
//	parse.go    blocks from Markdown
//	inline.go   inline content (marks and links) from Markdown
//	render.go   Markdown from blocks and inline content
package md

import (
	"encoding/json"
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

// TableRow is one row of a table: a cell is inline content, or an object
// holding it.
type TableRow struct {
	Cells []json.RawMessage `json:"cells"`
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

// plainInline is inline content's text, with labels for mentions and
// chips.
func plainInline(content json.RawMessage) string {
	var ins []Inline
	if len(content) == 0 || json.Unmarshal(content, &ins) != nil {
		var s string
		if err := json.Unmarshal(content, &s); err != nil {
			return "" // neither inline content nor text: nothing to show
		}
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
