package cli

import (
	"bytes"
	"errors"
	"testing"
)

// maskAll writes each piece through a new masker, flushes it and gives
// what came out.
func maskAll(t *testing.T, env map[string]string, pieces ...string) string {
	t.Helper()
	var out bytes.Buffer
	m := newMasker(&out, env)
	for _, p := range pieces {
		if _, err := m.Write([]byte(p)); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Flush(); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func TestMaskerBlanksSecrets(t *testing.T) {
	cases := []struct {
		name   string
		env    map[string]string
		pieces []string
		want   string
	}{
		{"one write", map[string]string{"K": "hunter22"}, []string{"key=hunter22\n"}, "key=•••\n"},
		{"split across two writes", map[string]string{"K": "hunter22"}, []string{"key=hun", "ter22\n"}, "key=•••\n"},
		{"split across two writes with no line end", map[string]string{"K": "hunter22"}, []string{"key=hun", "ter22"}, "key=•••"},
		{"at the very end of the stream", map[string]string{"K": "hunter22"}, []string{"done\nhunter22"}, "done\n•••"},
		{"two secrets", map[string]string{"A": "alpha-1", "B": "bravo-2"}, []string{"alpha-1 and bravo-2\n"}, "••• and •••\n"},
		{"the same secret twice", map[string]string{"A": "alpha-1"}, []string{"alpha-1alpha-1\n"}, "••••••\n"},
		{"a value too short to blank", map[string]string{"A": "abc"}, []string{"abc\n"}, "abc\n"},
		{"an empty value", map[string]string{"A": ""}, []string{"plain text\n"}, "plain text\n"},
		{"no secrets", nil, []string{"plain", " text\n"}, "plain text\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := maskAll(t, tc.env, tc.pieces...); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// A secret that begins with another one is blanked whole, whichever of
// the two the masker happens to look at first.
func TestMaskerBlanksASecretThatStartsWithAnother(t *testing.T) {
	env := map[string]string{"SHORT": "token", "LONG": "token-and-more"}
	for range 50 { // the values come from a map, in no fixed order
		if got := maskAll(t, env, "use token-and-more or token\n"); got != "use ••• or •••\n" {
			t.Fatalf("got %q", got)
		}
	}
}

func TestMaskerWritesOutALongLineWithNoEnd(t *testing.T) {
	var out bytes.Buffer
	m := newMasker(&out, map[string]string{"K": "hunter22"})
	long := bytes.Repeat([]byte("x"), maskHold)
	if _, err := m.Write(long); err != nil {
		t.Fatal(err)
	}
	if out.Len() != maskHold {
		t.Fatalf("wrote %d bytes before the flush, want %d", out.Len(), maskHold)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("disk full") }

func TestMaskerFlushSaysTheWriteFailed(t *testing.T) {
	m := newMasker(failingWriter{}, nil)
	if _, err := m.Write([]byte("no line end")); err != nil {
		t.Fatal(err)
	}
	if err := m.Flush(); err == nil {
		t.Fatal("Flush returned no error when the write failed")
	}
}
