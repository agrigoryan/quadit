// The comment markers in inline content. The words a comment thread is on
// carry its id in their styles, "comment": "ID ID" for the threads on them,
// so the marker moves with the words as the editor changes the text.
//
// A place in a block is counted in characters (Unicode code points) of its
// text as Plain reads it: a mention or a chip counts as its label, and
// carries no marker of its own. Content that is not a list of inline things
// (a table's) has no markers here.

package md

import (
	"bytes"
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// commentStyle is the style that holds the threads on a run of text.
const commentStyle = "comment"

// threads is the ids of the threads the styles carry.
func (s Styles) threads() []string {
	v, _ := s[commentStyle].(string)
	return strings.Fields(v)
}

// setThreads puts threads on the styles, sorted and each once; none takes
// the style off.
func (s Styles) setThreads(ids []string) {
	ids = slices.Clone(ids)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	if len(ids) == 0 {
		delete(s, commentStyle)
		return
	}
	s[commentStyle] = strings.Join(ids, " ")
}

// Threads is the ids of the threads that have words in content, sorted.
func Threads(content json.RawMessage) []string {
	if !bytes.Contains(content, []byte(`"`+commentStyle+`"`)) {
		return nil
	}
	ins, ok := readInlines(content)
	if !ok {
		return nil
	}
	var ids []string
	each(ins, func(in Inline, _, _ int) {
		ids = append(ids, in.Styles.threads()...)
	})
	slices.Sort(ids)
	return slices.Compact(ids)
}

// Marked is the words a thread is on in content, each stretch of them
// apart, in the order they come.
func Marked(content json.RawMessage, thread string) []string {
	ins, ok := readInlines(content)
	if !ok {
		return nil
	}
	text := []rune(plainInline(content))
	var words []string
	for _, r := range threadRanges(ins, thread) {
		words = append(words, string(text[r[0]:r[1]]))
	}
	return words
}

// Mark puts a thread on the text from character start up to end. It is
// false, and content unchanged, when the range is not in the text or holds
// no text that can carry a marker (only a chip), or the content is not
// inline content.
func Mark(content json.RawMessage, start, end int, thread string) (json.RawMessage, bool) {
	ins, ok := readInlines(content)
	if !ok || start < 0 || start >= end || end > utf8.RuneCountInString(plainInline(content)) {
		return content, false
	}
	marked := false
	out := rewrite(ins, func(run Inline, at int) []Inline {
		text := []rune(run.Text)
		from, to := max(start-at, 0), min(end-at, len(text))
		if from >= to {
			return []Inline{run}
		}
		marked = true
		parts := []Inline{}
		if from > 0 {
			parts = append(parts, withText(run, text[:from]))
		}
		middle := withText(run, text[from:to])
		middle.Styles = withThreads(middle.Styles, append(middle.Styles.threads(), thread))
		parts = append(parts, middle)
		if to < len(text) {
			parts = append(parts, withText(run, text[to:]))
		}
		return parts
	})
	if !marked {
		return content, false
	}
	return plainjson.Marshal(out), true
}

// RenameThreads gives each thread on content the id rename gives it, or
// takes it off where that is "". Content with no threads comes back as it
// was given.
func RenameThreads(content json.RawMessage, rename func(id string) string) json.RawMessage {
	if len(Threads(content)) == 0 {
		return content
	}
	ins, _ := readInlines(content)
	out := rewrite(ins, func(run Inline, _ int) []Inline {
		var ids []string
		for _, id := range run.Styles.threads() {
			if to := rename(id); to != "" {
				ids = append(ids, to)
			}
		}
		run.Styles = withThreads(run.Styles, ids)
		return []Inline{run}
	})
	return plainjson.Marshal(out)
}

// CarryMarks puts a thread back on the words it was on in old, now that
// the block's content is now. The two texts are compared character by
// character; when most of the words are still there, the characters left
// of them, and what was typed among them, get the thread. It is false, and
// now unchanged, when the words are gone.
//
// Characters kept alone or in twos do not count as words still there: a
// comparison of two texts finds a few letters in common in any two.
func CarryMarks(old, now json.RawMessage, thread string) (json.RawMessage, bool) {
	ins, ok := readInlines(old)
	if !ok {
		return now, false
	}
	was, is := []rune(plainInline(old)), []rune(plainInline(now))
	moved := charMap(was, is)
	carried := false
	for _, r := range threadRanges(ins, thread) {
		least := min(3, r[1]-r[0]) // the shortest stretch kept that counts
		lo, hi, kept := -1, -1, 0
		first, last := -1, -1 // the words' characters lo and hi are
		for i := r[0]; i < r[1]; {
			if moved[i] < 0 {
				i++
				continue
			}
			end := i + 1 // the stretch kept together from i
			for end < r[1] && moved[end] == moved[end-1]+1 {
				end++
			}
			if end-i >= least {
				if lo < 0 {
					lo, first = moved[i], i
				}
				hi, last, kept = moved[end-1], end-1, kept+end-i
			}
			i = end
		}
		if lo < 0 || 2*kept < r[1]-r[0] {
			continue
		}
		// The comparison may pair a letter at an edge of the words with the
		// same letter beside them in the new text ("a" of "alpha" with the
		// one ending "delta" before it): the words' own letters next to
		// what was found are theirs.
		for ; first > r[0] && lo > 0 && is[lo-1] == was[first-1]; first-- {
			lo--
		}
		for ; last < r[1]-1 && hi < len(is)-1 && is[hi+1] == was[last+1]; last++ {
			hi++
		}
		var done bool
		if now, done = Mark(now, lo, hi+1, thread); done {
			carried = true
		}
	}
	return now, carried
}

// TakeMarks gives the threads named the places they have in written, on
// old, whose text is the same: a thread written nowhere in it is taken off
// old. The other threads on old stay where they are.
func TakeMarks(old, written json.RawMessage, threads []string) json.RawMessage {
	ins, ok := readInlines(written)
	if !ok {
		return old
	}
	out := RenameThreads(old, func(id string) string {
		if slices.Contains(threads, id) {
			return ""
		}
		return id
	})
	for _, thread := range threads {
		for _, r := range threadRanges(ins, thread) {
			out, _ = Mark(out, r[0], r[1], thread)
		}
	}
	return out
}

// Find is where words start in content's text, in characters, each place
// they are; none for no words.
func Find(content json.RawMessage, words string) []int {
	w := []rune(words)
	if len(w) == 0 {
		return nil
	}
	text := []rune(plainInline(content))
	var at []int
	for i := 0; i+len(w) <= len(text); i++ {
		if slices.Equal(text[i:i+len(w)], w) {
			at = append(at, i)
		}
	}
	return at
}

// FindAdded is where words start in now's text, as Find gives them, that
// an edit from was put there: the places where at least one of their
// characters is not one now keeps from was. Words was had already, which
// the edit left in place, are not counted.
func FindAdded(was, now json.RawMessage, words string) []int {
	at := Find(now, words)
	if len(at) == 0 {
		return nil
	}
	text := []rune(plainInline(now))
	kept := make([]bool, len(text))
	for _, j := range charMap([]rune(plainInline(was)), text) {
		if j >= 0 {
			kept[j] = true
		}
	}
	n := utf8.RuneCountInString(words)
	return slices.DeleteFunc(at, func(i int) bool { return !slices.Contains(kept[i:i+n], false) })
}

// readInlines reads inline content; false for content that is not a list
// of inline things.
func readInlines(content json.RawMessage) ([]Inline, bool) {
	var ins []Inline
	if len(content) == 0 || content[0] != '[' || json.Unmarshal(content, &ins) != nil {
		return nil, false
	}
	return ins, true
}

// each hands every text run of inline content, inside links too, to f with
// the place of its first character and its length.
func each(ins []Inline, f func(run Inline, start, n int)) {
	rewrite(ins, func(run Inline, at int) []Inline {
		f(run, at, utf8.RuneCountInString(run.Text))
		return []Inline{run}
	})
}

// rewrite makes inline content anew a text run at a time: each run is
// handed to f with the place of its first character, and what f gives
// takes its place. Links are walked into; a mention or a chip is kept as
// it is, counted as its label. Runs left alike side by side become one.
func rewrite(ins []Inline, f func(run Inline, at int) []Inline) []Inline {
	at := 0
	var walk func([]Inline) []Inline
	walk = func(list []Inline) []Inline {
		var out []Inline
		for _, in := range list {
			switch in.Type {
			case "link":
				in.Content = walk(in.Content)
				out = append(out, in)
			case "text":
				out = append(out, f(in, at)...)
				at += utf8.RuneCountInString(in.Text)
			default:
				out = append(out, in)
				at += utf8.RuneCountInString(in.Text + in.label())
			}
		}
		return joined(out)
	}
	return walk(ins)
}

// joined is inline content with runs of the same styles side by side made
// one, and runs with no text left out.
func joined(ins []Inline) []Inline {
	out := []Inline{}
	for _, in := range ins {
		if in.Type == "text" && in.Text == "" {
			continue
		}
		if n := len(out); n > 0 && in.Type == "text" && out[n-1].Type == "text" && sameStyles(out[n-1].Styles, in.Styles) {
			out[n-1].Text += in.Text
			continue
		}
		out = append(out, in)
	}
	return out
}

// sameStyles says whether two runs look alike: no styles and empty styles
// are the same.
func sameStyles(a, b Styles) bool {
	return len(a) == 0 && len(b) == 0 || reflect.DeepEqual(a, b)
}

// withText is a run like run, with other text.
func withText(run Inline, text []rune) Inline {
	run.Text = string(text)
	return run
}

// withThreads is a copy of styles with these threads on it; nil when
// nothing is left.
func withThreads(styles Styles, ids []string) Styles {
	out := Styles{}
	maps.Copy(out, styles)
	out.setThreads(ids)
	if len(out) == 0 {
		return nil
	}
	return out
}

// threadRanges is where a thread is on inline content: each stretch from
// its first character up to the one after its last. A mention or a chip
// between two runs on the thread does not break the stretch.
func threadRanges(ins []Inline, thread string) [][2]int {
	var out [][2]int
	growing := false
	at := 0
	var walk func([]Inline)
	walk = func(list []Inline) {
		for _, in := range list {
			switch in.Type {
			case "link":
				walk(in.Content)
			case "text":
				n := utf8.RuneCountInString(in.Text)
				switch {
				case n == 0:
				case !slices.Contains(in.Styles.threads(), thread):
					growing = false
				case growing:
					out[len(out)-1][1] = at + n
				default:
					out = append(out, [2]int{at, at + n})
					growing = true
				}
				at += n
			default:
				at += utf8.RuneCountInString(in.Text + in.label())
			}
		}
	}
	walk(ins)
	return out
}

// charMap is where each character of a is in b, or -1 where it is not:
// their longest common subsequence, the text both keep. Past what can be
// compared in reasonable time and memory, only the common start and end
// are matched.
func charMap(a, b []rune) []int {
	moved := make([]int, len(a))
	for i := range moved {
		moved[i] = -1
	}
	head := 0
	for head < len(a) && head < len(b) && a[head] == b[head] {
		moved[head] = head
		head++
	}
	tail := 0
	for tail < len(a)-head && tail < len(b)-head && a[len(a)-1-tail] == b[len(b)-1-tail] {
		moved[len(a)-1-tail] = len(b) - 1 - tail
		tail++
	}
	midA, midB := a[head:len(a)-tail], b[head:len(b)-tail]
	if len(midA) == 0 || len(midB) == 0 || len(midA)*len(midB) > maxCompared {
		return moved
	}
	// lengths[i][j] is the longest common subsequence of midA[i:] and midB[j:].
	w := len(midB) + 1
	lengths := make([]int32, (len(midA)+1)*w)
	for i, a := range slices.Backward(midA) {
		for j, b := range slices.Backward(midB) {
			if a == b {
				lengths[i*w+j] = lengths[(i+1)*w+j+1] + 1
			} else {
				lengths[i*w+j] = max(lengths[(i+1)*w+j], lengths[i*w+j+1])
			}
		}
	}
	for i, j := 0, 0; i < len(midA) && j < len(midB); {
		switch {
		case midA[i] == midB[j]:
			moved[head+i] = head + j
			i++
			j++
		case lengths[(i+1)*w+j] >= lengths[i*w+j+1]:
			i++
		default:
			j++
		}
	}
	return moved
}

// maxCompared is how many pairs of characters charMap compares at most:
// a few megabytes of memory.
const maxCompared = 1 << 20
