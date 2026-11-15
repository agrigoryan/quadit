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
// an unfinished line, so a value split across two writes is still caught.
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
	if i < 0 {
		i = len(m.held) - 1
	}
	out := m.held[:i+1]
	m.held = append([]byte(nil), m.held[i+1:]...)
	_, err := m.w.Write(m.mask(out))
	return len(p), err
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
