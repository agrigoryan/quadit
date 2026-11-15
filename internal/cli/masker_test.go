package cli

import (
	"bytes"
	"testing"
)

// A secret that begins with another one is blanked whole, whichever of
// the two the masker happens to look at first.
func TestMaskerBlanksASecretThatStartsWithAnother(t *testing.T) {
	env := map[string]string{"SHORT": "token", "LONG": "token-and-more"}
	for range 50 { // the values come from a map, in no fixed order
		var out bytes.Buffer
		m := newMasker(&out, env)
		if _, err := m.Write([]byte("use token-and-more or token\n")); err != nil {
			t.Fatal(err)
		}
		m.Flush()
		if got := out.String(); got != "use ••• or •••\n" {
			t.Fatalf("got %q", got)
		}
	}
}
