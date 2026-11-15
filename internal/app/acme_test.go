package app

import (
	"crypto/tls"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestAutomaticCertificate runs the server in its --tls-domain mode against
// a real ACME authority and checks that it gets a certificate for its name,
// serves with it, and sends plain-HTTP visitors to HTTPS.
//
// It needs an authority that can reach this machine under that name, so it
// runs only when told where one is:
//
//	QUADIT_TEST_ACME=<directory url>,<ca pem file>,<name>,<https listen>,<http listen>
//
// With Pebble (Let's Encrypt's test authority, which checks on ports 5001
// and 5002) and its pebble-challtestsrv as the resolver answering 127.0.0.1:
//
//	QUADIT_TEST_ACME=https://localhost:14000/dir,pebble.minica.pem,quadit.test,127.0.0.1:5001,127.0.0.1:5002
func TestAutomaticCertificate(t *testing.T) {
	spec := os.Getenv("QUADIT_TEST_ACME")
	if spec == "" {
		t.Skip("QUADIT_TEST_ACME is not set")
	}
	p := strings.Split(spec, ",")
	if len(p) != 5 {
		t.Fatal("QUADIT_TEST_ACME wants: directory,ca file,name,https listen,http listen")
	}
	dir, ca, name, listen, plain := p[0], p[1], p[2], p[3], p[4]
	go Serve([]string{"--data", t.TempDir(), "--tls-domain", name, "--listen", listen,
		"--acme-http-listen", plain, "--acme-directory", dir, "--acme-ca", ca,
		"--local-listen", "127.0.0.1:0"}, "test")

	// The first handshake is what asks for the certificate.
	var state tls.ConnectionState
	deadline := time.Now().Add(90 * time.Second)
	for {
		// The authority's root is not known here; the chain is checked by name below.
		conn, err := tls.Dial("tcp", listen, &tls.Config{ServerName: name, InsecureSkipVerify: true, NextProtos: []string{"h2", "http/1.1"}}) //nolint:gosec
		if err == nil {
			state = conn.ConnectionState()
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no certificate after 90 s: %v", err)
		}
		time.Sleep(time.Second)
	}
	leaf := state.PeerCertificates[0]
	if !slices.Contains(leaf.DNSNames, name) {
		t.Fatalf("the certificate is for %v, not %s", leaf.DNSNames, name)
	}
	if leaf.Issuer.String() == leaf.Subject.String() {
		t.Fatal("the certificate is self-signed: it did not come from the authority")
	}
	if state.NegotiatedProtocol != "h2" {
		t.Errorf("negotiated %q, want h2", state.NegotiatedProtocol)
	}

	// Plain HTTP sends a visitor to HTTPS.
	req, _ := http.NewRequest("GET", "http://"+plain+"/games", nil)
	req.Host = name
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if loc := res.Header.Get("Location"); res.StatusCode != http.StatusFound || !strings.HasPrefix(loc, "https://"+name) {
		t.Fatalf("plain HTTP answered %d to %q", res.StatusCode, loc)
	}
}
