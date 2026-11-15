// Package cli is the command-line tool: one binary for people and agents.
// Its output is short on purpose; --json gives the full data.
//
// How the package is laid out:
//
//	cli.go        Run, and how a command reads and writes through the API
//	commands.go   the table of commands: each name, what it needs, what runs
//	args.go       switches, field=value arguments and their values
//	help.go       the help texts
//	client.go     the API client: requests, changes, uploads
//	login.go      saving the server's address and a token
//	cmd_*.go      what the commands do, by the groups the help gives them:
//	              read (orient, find), follow, task, decision, files, do,
//	              docs, secrets
//	listen.go, link.go, render.go, import.go   the larger commands, one each
//	masker.go     blanking secrets out of what a command prints
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// Run runs a client command and returns the process exit code. It is the
// client's main: the context its requests run under starts here.
func Run(args []string, stdout, stderr io.Writer) int {
	ctx := context.Background()
	sw, rest := takeSwitches(args)
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "-h" || rest[0] == "--help" {
		fmt.Fprint(stdout, helpFor(rest))
		return 0
	}
	cmd, rest := rest[0], rest[1:]
	if cmd == "login" {
		return login(ctx, rest, stdout, stderr)
	}
	c, err := NewClient()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	c.ChangeID, c.For = sw.changeID, sw.actFor
	r := &runner{ctx: ctx, c: c, out: stdout, json: sw.json, dry: sw.dry}
	if err := r.run(cmd, rest); err != nil {
		fmt.Fprintln(stderr, err)
		var ae *APIError
		if errors.As(err, &ae) && ae.Status == 429 {
			return 75 // try again later
		}
		return 1
	}
	return 0
}

// runner is one run of a command: the server it talks to, where it prints,
// and the switches it was given. Being one run, it holds the run's context.
type runner struct {
	ctx  context.Context
	c    *Client
	out  io.Writer
	json bool
	dry  bool
}

// run finds a command by its name and runs it on what was typed after it.
func (r *runner) run(name string, rest []string) error {
	cmd, ok := findCommand(name)
	if !ok {
		return fmt.Errorf("unknown command %q; run: quadit help", name)
	}
	in := readInput(name, rest)
	if len(in.pos) < cmd.args {
		return errors.New("usage: quadit " + cmd.usage)
	}
	return cmd.run(r, in)
}

// printRead prints a read in text form, or as JSON when asked.
func (r *runner) printRead(path string, q url.Values) error {
	if r.json {
		raw, err := r.c.JSON(r.ctx, path, q)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		if json.Indent(&buf, raw, "", "  ") == nil {
			raw = buf.Bytes()
		}
		fmt.Fprintln(r.out, strings.TrimSpace(string(raw)))
		return nil
	}
	text, err := r.c.Text(r.ctx, path, q)
	fmt.Fprint(r.out, text)
	return err
}

// change applies a change and prints one line about it.
func (r *runner) change(typ string, args map[string]any, approval string) error {
	res, err := r.c.Change(r.ctx, typ, args, ChangeOptions{Approval: approval, DryRun: r.dry})
	if err != nil {
		return err
	}
	if r.json {
		raw := plainjson.Marshal(res)
		fmt.Fprintln(r.out, string(raw))
		return nil
	}
	line := "ok " + typ
	if r.dry {
		line = "would be accepted: " + typ
	}
	if res.Key != "" {
		line += " " + res.Key
	}
	if res.Ref != "" && res.Ref != res.Key {
		line += " id=" + res.Ref
	}
	fmt.Fprintf(r.out, "%s seq=%d\n", line, res.Seq)
	return nil
}

// send sends a JSON body to a path that is not a change (a cursor, a note
// to memory, a request with a secret) and returns the answer.
func (r *runner) send(method, path string, q url.Values, body any, accept string) ([]byte, error) {
	raw := plainjson.Marshal(body)
	return r.c.workspaceRequest(r.ctx, apiRequest{method: method, path: path, query: q, body: bytes.NewReader(raw), contentType: "application/json", accept: accept})
}
