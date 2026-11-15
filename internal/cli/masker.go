// The secret masker: blanking secret values out of what a command prints.

package cli

import (
	"bytes"
	"cmp"
	"io"
	"slices"
	"sync"
)

// masker passes text through with secret values blanked out. It holds back
// an unfinished line, and a value that may run on into the next write (one
// with a line end in it, begun before the last line end), so a value split
// across two writes is still caught.
type masker struct {
	mu     sync.Mutex
	w      io.Writer
	values []string
	held   []byte
}

// maskHold is the most of an unfinished line held back before it is
// written out anyway.
const maskHold = 64 << 10

// newMasker makes a masker that writes to w with the values of env blanked
// out; a value shorter than four characters is too common to blank.
func newMasker(w io.Writer, env map[string]string) *masker {
	m := &masker{w: w}
	for _, v := range env {
		if len(v) >= 4 {
			m.values = append(m.values, v)
		}
	}
	// Longest first, so a value that begins with another is blanked whole
	// and not left with its tail showing.
	slices.SortFunc(m.values, func(a, b string) int { return cmp.Compare(len(b), len(a)) })
	return m
}

// Write passes on what is written up to its last line end, masked, and
// holds back the rest.
func (m *masker) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.held = append(m.held, p...)
	i := bytes.LastIndexByte(m.held, '\n')
	if i < 0 && len(m.held) < maskHold {
		return len(p), nil
	}
	cut := i + 1
	if i < 0 {
		cut = len(m.held)
	}
	cut = m.safeCut(m.held, cut)
	out := m.held[:cut]
	m.held = append([]byte(nil), m.held[cut:]...)
	_, err := m.w.Write(m.mask(out))
	return len(p), err
}

// safeCut moves cut back, if need be, so that no secret value in b crosses
// it: one that begins before cut and ends after it, or that begins before cut
// and runs to the end of b, where the next write may finish it. What is
// before the cut can then be masked on its own.
func (m *masker) safeCut(b []byte, cut int) int {
	for moved := true; moved; {
		moved = false
		for _, v := range m.values {
			for start := max(0, cut-len(v)+1); start < cut; start++ {
				rest := b[start:]
				crosses := len(rest) >= len(v) && bytes.HasPrefix(rest, []byte(v))
				begun := len(rest) < len(v) && bytes.HasPrefix([]byte(v), rest)
				if crosses || begun {
					cut, moved = start, true
					break
				}
			}
		}
	}
	return cut
}

// mask blanks every secret value out of b.
func (m *masker) mask(b []byte) []byte {
	for _, v := range m.values {
		b = bytes.ReplaceAll(b, []byte(v), []byte("•••"))
	}
	return b
}

// Flush writes out what is held back, and says if it could not.
func (m *masker) Flush() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.held) == 0 {
		return nil
	}
	_, err := m.w.Write(m.mask(m.held))
	m.held = nil
	return err
}
