package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

// request has the server make an HTTP request with a secret written into
// it, and prints the answer.
func (r *runner) request(in input) error {
	req := map[string]any{"url": in.pos[1], "method": first(in.f["method"])}
	headers := map[string]string{}
	for _, h := range in.f["header"] {
		k, v, ok := strings.Cut(h, ":")
		if !ok {
			return fmt.Errorf("header=%q: write header=Name:value", h)
		}
		headers[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	req["headers"] = headers
	if b := first(in.f["body"]); b == "-" {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		req["body"] = string(raw)
	} else {
		req["body"] = b
	}
	format, accept := "text", "text/plain"
	if r.json {
		format, accept = "json", "application/json"
	}
	out, err := r.send("POST", "/secrets/"+url.PathEscape(in.pos[0])+"/request", url.Values{"format": {format}}, req, accept)
	if err != nil {
		return err
	}
	fmt.Fprint(r.out, string(out))
	return nil
}

// secretEnv asks the server for the secrets a companion may put in a
// command's environment.
func (r *runner) secretEnv(names []string) (map[string]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	out, err := r.send("POST", "/secrets/env", nil, map[string]any{"names": names}, "application/json")
	if err != nil {
		return nil, err
	}
	var res struct {
		Env map[string]string `json:"env"`
	}
	return res.Env, json.Unmarshal(out, &res)
}

// secretCommand makes a command that has the secrets in its environment,
// each under its name, after whatever more adds to it; and the masker its
// output goes through. The caller gives the command its input, runs it and
// flushes the masker.
func (r *runner) secretCommand(command []string, env map[string]string, more ...string) (*exec.Cmd, *masker) {
	out := newMasker(r.out, env)
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = append(os.Environ(), more...)
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdout, cmd.Stderr = out, out
	return cmd, out
}

// runWithSecrets runs a command with secrets in its environment and blanks
// their values out of what it prints.
func (r *runner) runWithSecrets(in input) error {
	var names, command []string
	args := in.rest
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--secret" && i+1 < len(args):
			names = append(names, args[i+1])
			i++
		case args[i] == "--":
			command = args[i+1:]
			i = len(args)
		default:
			command = args[i:]
			i = len(args)
		}
	}
	if len(command) == 0 || len(names) == 0 {
		return errors.New("usage: quadit run --secret NAME [--secret NAME ...] -- COMMAND [ARG ...]")
	}
	env, err := r.secretEnv(names)
	if err != nil {
		return err
	}
	cmd, out := r.secretCommand(command, env)
	defer out.Flush()
	cmd.Stdin = os.Stdin
	return cmd.Run()
}
