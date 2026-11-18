package app

import (
	"net/netip"
	"slices"
	"testing"
)

// TestNetworksAreReadAsWritten: a list of networks in a flag or the
// environment takes networks and single addresses, split by commas or
// spaces; anything else stops the server rather than being left out.
func TestNetworksAreReadAsWritten(t *testing.T) {
	got, err := networks("10.0.0.0/8, 192.168.1.20 ::1,fd00::/8")
	want := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("192.168.1.20/32"), netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("fd00::/8")}
	if err != nil || !slices.Equal(got, want) {
		t.Fatalf("networks = %v, %v; want %v", got, err, want)
	}
	if got, err := networks(""); err != nil || len(got) != 0 {
		t.Fatalf("an empty list = %v, %v", got, err)
	}
	for _, bad := range []string{"192.168.1", "localhost", "10.0.0.0/33"} {
		if _, err := networks(bad); err == nil {
			t.Errorf("%q was taken", bad)
		}
	}
}
