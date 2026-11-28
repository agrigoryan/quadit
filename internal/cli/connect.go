// The connect command: an agent proving, from inside its tool, that it
// reaches Quadit, by giving back the code a person made for it.

package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode"
)

// connect gives back a connect code with this login and says what to tell
// the person. It starts no wait: listening is for the person to ask.
// Without a code it says who this login is and how to prove it. The login
// is the one of the workspace the code's line names (--workspace=), or the
// tool's only one, never the folder's: a code is sent to the server that
// made it alone.
func (r *runner) connect(in input) error {
	if len(in.pos) == 0 {
		me, err := r.c.me(r.ctx)
		if err != nil {
			return err
		}
		if me.Kind != "agent" {
			fmt.Fprintf(r.out, "This login is %s's, a person's, not an agent's: an agent connects with its own login.\n", me.Handle)
			return nil
		}
		fmt.Fprintf(r.out, "You are %s in %s. A code from the person proves the connection: quadit connect CODE\n", me.Handle, me.Workspace.Name)
		return nil
	}
	// "Connect to Quadit K7PQ2M in Acme" names its workspace; the code alone is sent.
	if slices.ContainsFunc(in.pos, func(word string) bool { return strings.EqualFold(word, "in") }) {
		return errors.New("name the workspace with --workspace=, not in the code: quadit connect CODE --workspace=NAME")
	}
	// As a person may have said it: in lower case, with spaces or a dash.
	code := strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(strings.Join(in.pos, "")))
	raw, err := r.send(http.MethodPost, "/connect", nil, map[string]string{"code": code}, "application/json")
	if err != nil {
		return err
	}
	var said struct {
		Agent     struct{ Handle string }
		Workspace struct{ Name string }
	}
	if err := json.Unmarshal(raw, &said); err != nil {
		return err
	}
	// What is printed goes to a model as it is: the command's own sentences, with only a handle of its form and the
	// workspace's name on one line, never text the server chose.
	who := "this agent"
	if handleForm.MatchString(said.Agent.Handle) {
		who = said.Agent.Handle
	}
	fmt.Fprintf(r.out, "Connected as %s in the workspace %s.\n%s\n", who, plainName(said.Workspace.Name), connectedOffer)
	return nil
}

// connectedOffer is what an agent tells the person once connected.
const connectedOffer = `Tell the person it is connected, and offer: say "listen to Quadit" and I will answer what comes in while this run stays active.`

// plainName is a name the server sent, on one line, without quotes or
// control characters, at most 60 characters, quoted.
func plainName(name string) string {
	name = strings.Map(func(r rune) rune {
		switch {
		case r == '"' || unicode.IsControl(r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r):
			return ' '
		}
		return r
	}, name)
	runes := []rune(strings.Join(strings.Fields(name), " "))
	return `"` + string(runes[:min(len(runes), 60)]) + `"`
}
