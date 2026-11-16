package id

import (
	"testing"
	"time"
)

func TestNewIsValidSortedAndUnique(t *testing.T) {
	const n = 20000 // more than the 4096 ids one millisecond can hold
	seen := make(map[string]bool, n)
	prev := ""
	for range n {
		s := New()
		if !Valid(s) {
			t.Fatalf("invalid id %q", s)
		}
		if s[14] != '7' {
			t.Fatalf("not version 7: %q", s)
		}
		if seen[s] {
			t.Fatalf("duplicate id %q", s)
		}
		if s <= prev {
			t.Fatalf("ids out of order: %q then %q", prev, s)
		}
		seen[s] = true
		prev = s
	}
}

func TestNewAtNeverGoesBackwards(t *testing.T) {
	a := NewAt(time.Now().Add(time.Hour))
	b := NewAt(time.Now()) // an earlier clock reading
	if b <= a {
		t.Fatalf("id went backwards: %q then %q", a, b)
	}
}

func TestValid(t *testing.T) {
	for s, want := range map[string]bool{
		"01a1d891-76cf-711f-9779-641448a15fc5": true,
		"01A1D891-76CF-711F-9779-641448A15FC5": false, // upper case
		"01a1d89176cf711f9779641448a15fc5":     false,
		"":                                     false,
		"01a1d891-76cf-711f-9779-641448a15fcz": false,
	} {
		if got := Valid(s); got != want {
			t.Errorf("Valid(%q) = %v, want %v", s, got, want)
		}
	}
}
