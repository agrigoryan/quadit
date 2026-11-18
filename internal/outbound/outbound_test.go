package outbound

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

// TestOnlyPublicAddressesAreReached: every kind of address that is not on
// the public internet is refused, in IPv4, IPv6 and IPv4 written as IPv6,
// unless the operator allowed its network.
func TestOnlyPublicAddressesAreReached(t *testing.T) {
	refused := []string{
		"127.0.0.1", "127.8.9.10", "0.0.0.0", "0.1.2.3", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", "169.254.0.1", "100.64.0.1", "100.100.100.100", "192.0.0.8", "198.18.0.1", "224.0.0.1",
		"239.255.255.250", "240.0.0.1", "255.255.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9",
		"::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "fec0::1", "::ffff:127.0.0.1",
		"::ffff:169.254.169.254", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
		"2002:a9fe:a9fe::1", "2001::1", "2001:db8::1", "100::1",
	}
	for _, s := range refused {
		if allowed(netip.MustParseAddr(s), nil) {
			t.Errorf("%s is reached", s)
		}
	}
	reached := []string{"1.1.1.1", "8.8.8.8", "142.250.74.78", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"}
	for _, s := range reached {
		if !allowed(netip.MustParseAddr(s), nil) {
			t.Errorf("%s is refused", s)
		}
	}
	lan := []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24"), netip.MustParsePrefix("::1/128")}
	for s, want := range map[string]bool{"192.168.1.20": true, "::ffff:192.168.1.20": true, "::1": true, "192.168.2.1": false, "127.0.0.1": false, "169.254.169.254": false} {
		if got := allowed(netip.MustParseAddr(s), lan); got != want {
			t.Errorf("with %v allowed, %s reached = %v, want %v", lan, s, got, want)
		}
	}
}

// TestTheClientRefusesWhatItConnectsTo: the check is made on the address a
// connection is opened to, after the name is resolved, so "localhost" is
// refused like 127.0.0.1; a redirect is handed back, not followed; and the
// operator's allowed networks open the way.
func TestTheClientRefusesWhatItConnectsTo(t *testing.T) {
	hits := 0
	local := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path == "/away" {
			http.Redirect(rw, r, "/here", http.StatusFound)
		}
	}))
	defer local.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(local.URL, "http://"))

	get := func(hc *http.Client, u string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
		resp, err := hc.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		return resp, err
	}
	for _, u := range []string{local.URL, "http://localhost:" + port + "/"} {
		_, err := get(Client(nil), u)
		var blocked *BlockedError
		if !errors.As(err, &blocked) || !blocked.Addr.IsLoopback() {
			t.Fatalf("%s: err = %v, want a BlockedError for a loopback address", u, err)
		}
	}
	if hits != 0 {
		t.Fatalf("the local server was reached %d times", hits)
	}

	allowedLocal := Client([]netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")})
	resp, err := get(allowedLocal, local.URL+"/away")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusFound || hits != 1 {
		t.Fatalf("a redirect: status %d after %d hits, want 302 after 1 (not followed)", resp.StatusCode, hits)
	}
}
