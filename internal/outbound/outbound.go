// Package outbound is the way out for the requests the server makes to
// addresses its users chose: browser push services, webhooks, the vault's
// requests, imports read from a service, GitHub integrations. Such an
// address could otherwise point the server at itself, at the machine's
// cloud metadata service or at anything else on its private network.
//
// It hides how a destination is judged. The check is made on each
// connection as it is opened, on the address it actually reaches after the
// name was resolved: a redirect's or a retry's connection is checked like
// the first, and a name that resolves to a public address when it is
// looked at and to a private one when it is used (DNS rebinding) gains
// nothing.
package outbound

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"
)

// Client returns an HTTP client that connects only to public addresses,
// and to those in the networks allowed lists (what the server's operator
// opened, for webhooks to a machine on the same network, say). It does not
// follow redirects: a redirect is the answer, as it came. A caller that
// wants them sets CheckRedirect; each hop is checked as it connects. It
// uses no proxy from the environment, which would make every connection
// one to the proxy, and has no timeout of its own: a caller bounds each
// request with its context.
func Client(allowedNets []netip.Prefix) *http.Client {
	dialer := &net.Dialer{
		Timeout:   dialTimeout,
		KeepAlive: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil {
				return fmt.Errorf("outbound: an address that does not read: %q", address)
			}
			if !allowed(ap.Addr(), allowedNets) {
				return &BlockedError{Addr: ap.Addr().Unmap()}
			}
			return nil
		},
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = dialer.DialContext
	return &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// dialTimeout is how long a connection may take to open.
const dialTimeout = 15 * time.Second

// BlockedError is a connection refused because its address is not public
// and its network was not allowed.
type BlockedError struct {
	Addr netip.Addr
}

func (e *BlockedError) Error() string {
	return fmt.Sprintf("%s is a private or local address; the server reaches only public addresses unless whoever runs it allows that network (QUADIT_ALLOW_PRIVATE_NETWORKS)", e.Addr)
}

// allowed reports whether a connection may be opened to addr: it is on the
// public internet, or in one of the networks allowed.
func allowed(addr netip.Addr, allowedNets []netip.Prefix) bool {
	addr = addr.Unmap()
	for _, p := range allowedNets {
		if p.Contains(addr) {
			return true
		}
	}
	if !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return false // loopback, link-local, multicast, unspecified; RFC 1918 and fc00::/7
	}
	for _, p := range notPublic {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}

// notPublic are the ranges that are not public addresses although Go's
// IsGlobalUnicast and IsPrivate do not say so: shared, reserved and
// documentation ranges, and the IPv6 ways of writing an IPv4 address that
// a gateway may turn back into a private one.
var notPublic = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8",       // "this network"
		"100.64.0.0/10",   // shared address space: carrier NAT, Tailscale
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // documentation
		"198.18.0.0/15",   // benchmarking
		"198.51.100.0/24", // documentation
		"203.0.113.0/24",  // documentation
		"240.0.0.0/4",     // reserved, and the broadcast address
		"::/96",           // IPv4-compatible IPv6
		"64:ff9b::/96",    // NAT64
		"64:ff9b:1::/48",  // local NAT64
		"100::/64",        // discard
		"2001::/23",       // IETF protocol assignments, Teredo among them
		"2001:db8::/32",   // documentation
		"2002::/16",       // 6to4
		"fec0::/10",       // site-local, deprecated
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()
