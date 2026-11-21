// The follow commands: ack and read, and the cursor they move.

package cli

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// ack marks the feed handled up to a sequence number, under a cursor's
// name ("main" when none is given). The cursor "listen" is moved with the
// listener's lease (lease=ID).
func (r *runner) ack(in input) error {
	seq, err := strconv.ParseInt(in.pos[0], 10, 64)
	if err != nil {
		return errors.New("SEQ is a number")
	}
	name := "main"
	if len(in.pos) > 1 {
		name = in.pos[1]
	}
	out, err := r.setCursor(name, seq, firstValue(in.f["lease"]))
	var ae *APIError
	if errors.As(err, &ae) && ae.Reason == "lease_ended" {
		return fmt.Errorf("%w\n  to go on: quadit wait (the item comes again)", err)
	}
	if err != nil {
		return err
	}
	if r.dry {
		fmt.Fprint(r.out, "would be accepted: ")
	}
	fmt.Fprintln(r.out, strings.TrimSpace(string(out)))
	return nil
}

// setCursor moves a cursor to a sequence number, with the listener's lease
// for the cursor "listen" (or none), and returns the server's answer.
func (r *runner) setCursor(name string, seq int64, lease string) ([]byte, error) {
	body := map[string]any{"seq": seq}
	if lease != "" {
		body["lease"] = lease
	}
	return r.send("PUT", "/cursors/"+url.PathEscape(name), nil, body, "")
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
	return r.change("notification.read", a, "")
}
