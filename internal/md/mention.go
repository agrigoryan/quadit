// Mentions of members in Markdown: @handle is written for a mention, and
// read back as one where it names a member.

package md

import (
	"encoding/json"
	"regexp"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// handleRE is a member's handle after "@" where the "@" starts a word (not
// in an address): the server's rule for a mention in any text.
var handleRE = regexp.MustCompile(`(^|[^A-Za-z0-9_@/])@([a-z0-9][a-z0-9_-]{1,31})`)

// Mentions turns each @handle in the text of blocks that names a member
// (isMember) into a mention, stored as the editor stores one: {type:
// "mention", props: {handle}}. Rendered, a mention is its @handle again, so
// Markdown read and written back is unchanged. A handle of nobody, marked
// text (code, bold…), a code block and a link's text stay as they are.
func Mentions(blocks []Block, isMember func(handle string) bool) []Block {
	out := make([]Block, len(blocks))
	for i, b := range blocks {
		b.Children = Mentions(b.Children, isMember)
		switch b.Type {
		case "codeBlock":
		case "table":
			var t Table
			if json.Unmarshal(b.Content, &t) == nil {
				for _, row := range t.Rows {
					for j, cell := range row.Cells {
						row.Cells[j] = mentionsIn(cell, isMember)
					}
				}
				b.Content = plainjson.Marshal(t)
			}
		default:
			b.Content = mentionsIn(b.Content, isMember)
		}
		out[i] = b
	}
	return out
}

// mentionsIn is inline content with the members' handles in its text runs
// made mentions; content that is not a list of inline things is left alone.
func mentionsIn(content json.RawMessage, isMember func(string) bool) json.RawMessage {
	var ins []Inline
	if len(content) == 0 || content[0] != '[' || json.Unmarshal(content, &ins) != nil {
		return content
	}
	var out []Inline
	changed := false
	for _, in := range ins {
		// A mention has no marks of its own: one inside bold or code is left as text, which writes back as it came.
		// The words a comment thread is on are no mark: a mention among them is one, outside the thread's words.
		if in.Type != "text" || len(withThreads(in.Styles, nil)) > 0 {
			out = append(out, in)
			continue
		}
		last := 0
		for _, m := range handleRE.FindAllStringSubmatchIndex(in.Text, -1) {
			at, end := m[4]-1, m[5] // the "@" and the end of the handle
			if !isMember(in.Text[m[4]:m[5]]) {
				continue
			}
			if at > last {
				run := in
				run.Text = in.Text[last:at]
				out = append(out, run)
			}
			out = append(out, Inline{Type: "mention", Props: map[string]any{"handle": in.Text[m[4]:m[5]]}})
			last, changed = end, true
		}
		if last == 0 {
			out = append(out, in)
		} else if last < len(in.Text) {
			run := in
			run.Text = in.Text[last:]
			out = append(out, run)
		}
	}
	if !changed {
		return content
	}
	return plainjson.Marshal(out)
}
