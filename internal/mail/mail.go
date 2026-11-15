// Package mail sends email through an SMTP server set in the admin area.
package mail

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Config is the mail server. TLS is "starttls" (default), "tls" or "none".
type Config struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	From     string `json:"from"`
	TLS      string `json:"tls"`
}

// Ready reports whether there is enough to send with.
func (c Config) Ready() bool { return c.Host != "" && c.From != "" }

// Message is one email. Text is required; HTML is optional.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// testRoots lets a test trust a server's own certificate; nil means the
// machine's trusted roots, as always outside tests.
var testRoots *x509.CertPool

// ErrNotConfigured is returned when no mail server is set.
var ErrNotConfigured = errors.New("no mail server is set up")

// The usual ports: submission with STARTTLS, and SMTP over TLS.
const (
	portSubmission = 587
	portTLS        = 465
)

// How long connecting may take, and the whole conversation after it.
const (
	dialTimeout    = 15 * time.Second
	sessionTimeout = 45 * time.Second
)

// Send delivers one message.
func Send(ctx context.Context, c Config, m Message) error {
	if !c.Ready() {
		return ErrNotConfigured
	}
	port := c.Port
	if port == 0 {
		port = portSubmission
		if c.TLS == "tls" {
			port = portTLS
		}
	}
	addr := net.JoinHostPort(c.Host, fmt.Sprint(port))
	d := net.Dialer{Timeout: dialTimeout}
	var conn net.Conn
	var err error
	tlsCfg := &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12, RootCAs: testRoots}
	if c.TLS == "tls" {
		conn, err = (&tls.Dialer{NetDialer: &d, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("mail: connect to %s: %w", addr, err)
	}
	if err := conn.SetDeadline(time.Now().Add(sessionTimeout)); err != nil {
		conn.Close()
		return fmt.Errorf("mail: %w", err)
	}
	cl, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("mail: %w", err)
	}
	if err := deliver(cl, c, tlsCfg, m); err != nil {
		cl.Close() //nolint:errcheck // the send has failed already; this only frees the connection
		return err
	}
	return cl.Quit()
}

// deliver has the server take one message: TLS and sign-in as the
// config asks, then the envelope and the message itself.
func deliver(cl *smtp.Client, c Config, tlsCfg *tls.Config, m Message) error {
	if c.TLS != "tls" && c.TLS != "none" {
		if ok, _ := cl.Extension("STARTTLS"); !ok {
			return errors.New("mail: the server does not offer STARTTLS; set TLS to \"tls\" or \"none\"")
		}
		if err := cl.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("mail: starttls: %w", err)
		}
	}
	if c.Username != "" {
		if err := cl.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
			return fmt.Errorf("mail: sign-in refused: %w", err)
		}
	}
	from := address(c.From)
	if err := cl.Mail(from); err != nil {
		return fmt.Errorf("mail: sender refused: %w", err)
	}
	if err := cl.Rcpt(address(m.To)); err != nil {
		return fmt.Errorf("mail: recipient refused: %w", err)
	}
	body := build(c.From, m)
	w, err := cl.Data()
	if err != nil {
		return fmt.Errorf("mail: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("mail: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mail: %w", err)
	}
	return nil
}

// address pulls the bare address out of "Name <a@b>".
func address(s string) string {
	if i, j := strings.LastIndex(s, "<"), strings.LastIndex(s, ">"); i >= 0 && j > i {
		return s[i+1 : j]
	}
	return strings.TrimSpace(s)
}

// clean keeps a header value on one line.
func clean(s string) string { return strings.NewReplacer("\r", "", "\n", " ").Replace(s) }

// build writes the message out: its headers, and the text alone or the
// text and the HTML as alternatives, each quoted-printable.
func build(from string, m Message) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\n", clean(from), clean(m.To),
		mime.QEncoding.Encode("utf-8", clean(m.Subject)), time.Now().Format(time.RFC1123Z))
	if m.HTML == "" {
		writePart(&b, "text/plain", m.Text)
		return b.Bytes()
	}
	const boundary = "quadit-alt-7f3a9c"
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%s\r\n\r\n", boundary)
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	writePart(&b, "text/plain", m.Text)
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	writePart(&b, "text/html", m.HTML)
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes()
}

// writePart writes one part of the message: its type and its body,
// quoted-printable with CRLF line ends.
func writePart(b *bytes.Buffer, ctype, body string) {
	fmt.Fprintf(b, "Content-Type: %s; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", ctype)
	qp := quotedprintable.NewWriter(b)
	_, _ = qp.Write([]byte(strings.ReplaceAll(body, "\n", "\r\n"))) // fails only when b does, and a bytes.Buffer cannot
	_ = qp.Close()                                                  // flushes into b, which cannot fail
	b.WriteString("\r\n")
}
