// Reading inline Markdown: bold, italic, strike, code, links and bare
// addresses.

package md

import "strings"

// ParseInline turns one run of Markdown text into inline content.
func ParseInline(s string) []Inline {
	p := &inlineParser{s: s, styles: map[string]bool{}}
	for p.i < len(s) {
		p.step()
	}
	p.flush()
	if p.out == nil {
		p.out = []Inline{}
	}
	return p.out
}

// inlineParser is one run of ParseInline: the text, how far it is read,
// what it has made, the text not yet made into a run, and the marks open.
type inlineParser struct {
	s      string
	i      int
	out    []Inline
	buf    strings.Builder
	styles map[string]bool
}

// step reads what starts at the current position: an escaped character,
// code, a mark, a link, a bare address, or a plain character.
func (p *inlineParser) step() {
	s, i, rest := p.s, p.i, p.s[p.i:]
	switch {
	case s[i] == '\\' && i+1 < len(s) && strings.ContainsRune("\\`*_{}[]()#+-.!|~>", rune(s[i+1])):
		p.buf.WriteByte(s[i+1])
		p.i += 2
	case s[i] == '`':
		p.code()
	case strings.HasPrefix(rest, "**") || strings.HasPrefix(rest, "__"):
		p.mark(rest[:2], "bold")
	case strings.HasPrefix(rest, "~~"):
		p.mark("~~", "strike")
	case (s[i] == '*' || s[i] == '_') && p.italicAt():
		p.toggle("italic")
		p.i++
	case s[i] == '[':
		p.link()
	case strings.HasPrefix(rest, "http://") || strings.HasPrefix(rest, "https://"):
		p.address()
	default:
		p.buf.WriteByte(s[i])
		p.i++
	}
}

// flush makes the text read so far into a run with the marks now open.
func (p *inlineParser) flush() {
	if p.buf.Len() == 0 {
		return
	}
	in := Inline{Type: "text", Text: p.buf.String()}
	if len(p.styles) > 0 {
		in.Styles = map[string]bool{}
		for k := range p.styles {
			in.Styles[k] = true
		}
	}
	p.out = append(p.out, in)
	p.buf.Reset()
}

// toggle opens a mark, or closes it when it is open.
func (p *inlineParser) toggle(name string) {
	p.flush()
	if p.styles[name] {
		delete(p.styles, name)
	} else {
		p.styles[name] = true
	}
}

// code reads `code` up to its closing backtick, with the marks open
// around it; a backtick with none is a plain character.
func (p *inlineParser) code() {
	rest := p.s[p.i:]
	end := strings.IndexByte(rest[1:], '`')
	if end < 0 {
		p.buf.WriteByte('`')
		p.i++
		return
	}
	p.flush()
	styles := map[string]bool{"code": true}
	for k := range p.styles {
		styles[k] = true
	}
	p.out = append(p.out, Inline{Type: "text", Text: rest[1 : 1+end], Styles: styles})
	p.i += end + 2
}

// mark reads a two-character marker of style: it toggles the style when
// it closes an open span or opens one that is closed later, and is plain
// text otherwise.
func (p *inlineParser) mark(marker, style string) {
	if p.styles[style] || opensSpan(p.s, p.i, marker) {
		p.toggle(style)
	} else {
		p.buf.WriteString(marker)
	}
	p.i += len(marker)
}

// italicAt says whether the single * or _ at the current position is
// emphasis rather than a literal character, such as the underscores in
// snake_case.
func (p *inlineParser) italicAt() bool {
	s, i := p.s, p.i
	c := s[i]
	if c == '_' && i > 0 && isWord(s[i-1]) && i+1 < len(s) && isWord(s[i+1]) {
		return false
	}
	if p.styles["italic"] {
		return i > 0 && s[i-1] != ' '
	}
	if i+1 >= len(s) || s[i+1] == ' ' || s[i+1] == c {
		return false
	}
	return strings.IndexByte(s[i+1:], c) >= 0
}

// link reads [text](href), its text taking the marks open around it; a [
// that starts no link is a plain character.
func (p *inlineParser) link() {
	text, href, n := linkAt(p.s[p.i:])
	if n == 0 {
		p.buf.WriteByte('[')
		p.i++
		return
	}
	p.flush()
	inner := ParseInline(text)
	for k := range inner {
		for st := range p.styles {
			if inner[k].Styles == nil {
				inner[k].Styles = map[string]bool{}
			}
			inner[k].Styles[st] = true
		}
	}
	p.out = append(p.out, Inline{Type: "link", Href: href, Content: inner})
	p.i += n
}

// address reads a bare http(s) address as a link to itself, leaving out
// the punctuation that ends a sentence around it.
func (p *inlineParser) address() {
	rest := p.s[p.i:]
	end := strings.IndexAny(rest, " \n\t<>")
	if end < 0 {
		end = len(rest)
	}
	for end > 0 && strings.ContainsRune(".,;:!?)", rune(rest[end-1])) {
		end--
	}
	p.flush()
	p.out = append(p.out, Inline{Type: "link", Href: rest[:end], Content: []Inline{{Type: "text", Text: rest[:end]}}})
	p.i += end
}

// opensSpan says whether a marker at i opens a span that is closed later.
func opensSpan(s string, i int, marker string) bool {
	rest := s[i+len(marker):]
	return rest != "" && rest[0] != ' ' && strings.Contains(rest, marker)
}

// isWord says whether c is a letter or a digit.
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
