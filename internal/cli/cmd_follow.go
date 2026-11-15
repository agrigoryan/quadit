package cli

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// ack marks the feed handled up to a sequence number, under a cursor's
// name ("main" when none is given).
func (r *runner) ack(in input) error {
	seq, err := strconv.ParseInt(in.pos[0], 10, 64)
	if err != nil {
		return errors.New("SEQ is a number")
	}
	name := "main"
	if len(in.pos) > 1 {
		name = in.pos[1]
	}
	out, err := r.setCursor(name, seq)
	if err == nil {
		fmt.Fprintln(r.out, strings.TrimSpace(string(out)))
	}
	return err
}

// setCursor moves a cursor to a sequence number and returns the server's
// answer.
func (r *runner) setCursor(name string, seq int64) ([]byte, error) {
	return r.send("PUT", "/cursors/"+url.PathEscape(name), nil, map[string]int64{"seq": seq}, "")
}

// markRead marks inbox items read: all of them, or the ones named.
func (r *runner) markRead(in input) error {
	a := map[string]any{}
	if len(in.pos) == 0 || in.pos[0] == "all" {
		a["all"] = true
	} else {
		a["ids"] = in.pos
	}
	if v := in.f["up_to"]; len(v) > 0 {
		a["up_to"] = apiValue("base_seq", v[0])
	}
	_, err := r.change("notification.read", a, "")
	return err
}
