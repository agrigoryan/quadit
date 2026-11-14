package mail

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
)

// fakeSMTP accepts one message and hands back what the client sent.
func fakeSMTP(t *testing.T) (addr string, got chan string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		say := func(s string) { conn.Write([]byte(s + "\r\n")) }
		say("220 test ESMTP")
		var all strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			all.WriteString(line)
			cmd := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case inData:
				if strings.TrimSpace(line) == "." {
					inData = false
					say("250 queued")
				}
			case strings.HasPrefix(cmd, "EHLO"):
				say("250-test")
				say("250 AUTH PLAIN")
			case strings.HasPrefix(cmd, "AUTH"):
				say("235 ok")
			case strings.HasPrefix(cmd, "DATA"):
				inData = true
				say("354 go on")
			case strings.HasPrefix(cmd, "QUIT"):
				say("221 bye")
				got <- all.String()
				return
			default:
				say("250 ok")
			}
		}
	}()
	return ln.Addr().String(), got
}

func TestSend(t *testing.T) {
	addr, got := fakeSMTP(t)
	host, port, _ := net.SplitHostPort(addr)
	var p int
	for _, c := range port {
		p = p*10 + int(c-'0')
	}
	// Plain sign-in is only offered on a local or encrypted connection;
	// 127.0.0.1 counts as local.
	cfg := Config{Host: host, Port: p, Username: "u", Password: "p", From: "Quadit <q@example.com>", TLS: "none"}
	err := Send(context.Background(), cfg, Message{To: "Aram <aram@example.com>", Subject: "Répondez: a question", Text: "Line one\nhttps://x.example/task/SVA-1", HTML: "<p>Line one</p>"})
	if err != nil {
		t.Fatal(err)
	}
	wire := <-got
	for _, want := range []string{"MAIL FROM:<q@example.com>", "RCPT TO:<aram@example.com>", "Subject: =?utf-8?q?R=C3=A9pondez:_a_question?=",
		"multipart/alternative", "Line one", "https://x.example/task/SVA-1", "<p>Line one</p>"} {
		if !strings.Contains(wire, want) {
			t.Errorf("the message on the wire misses %q:\n%s", want, wire)
		}
	}
	if err := Send(context.Background(), Config{}, Message{To: "a@b.c"}); err != ErrNotConfigured {
		t.Fatalf("no server set: %v", err)
	}
}
