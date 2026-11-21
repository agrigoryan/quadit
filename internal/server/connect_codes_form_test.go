package server

import (
	"regexp"
	"testing"
)

// TestConnectCodesAreOfTheFormTheAppAccepts: every code is six upper-case
// characters from A to Z and 2 to 9 without O, I and L, the form the
// desktop app takes a code in; a lease id is eight of the same.
func TestConnectCodesAreOfTheFormTheAppAccepts(t *testing.T) {
	code := regexp.MustCompile(`^[A-HJKMNP-Z2-9]{6}$`)
	lease := regexp.MustCompile(`^[A-HJKMNP-Z2-9]{8}$`)
	for range 5000 {
		if c := randomCode(codeLength); !code.MatchString(c) {
			t.Fatalf("a connect code %q is not of the form", c)
		}
		if l := randomCode(leaseLength); !lease.MatchString(l) {
			t.Fatalf("a lease id %q is not of the form", l)
		}
	}
}
