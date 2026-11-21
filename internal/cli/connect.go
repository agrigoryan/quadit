// The connect command: an agent proving, from inside its tool, that it
// reaches Quadit, by giving back the code a person made for it.

package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// connect gives back a connect code with this login and says what to tell
// the person. It starts no wait: listening is for the person to ask.
// Without a code it says who this login is and how to prove it.
func (r *runner) connect(in input) error {
	if len(in.pos) == 0 {
		raw, err := r.c.JSON(r.ctx, "/me", url.Values{})
		if err != nil {
			return err
		}
		var me struct {
			Handle, Kind string
			Workspace    struct{ Name string }
		}
		if err := json.Unmarshal(raw, &me); err != nil {
			return err
		}
		if me.Kind != "agent" {
			fmt.Fprintf(r.out, "This login is %s's, a person's, not an agent's: an agent connects with its own login.\n", me.Handle)
			return nil
		}
		fmt.Fprintf(r.out, "You are %s in %s. A code from the person proves the connection: quadit connect CODE\n", me.Handle, me.Workspace.Name)
		return nil
	}
	raw, err := r.send(http.MethodPost, "/connect", nil, map[string]string{"code": strings.Join(in.pos, "")}, "application/json")
	if err != nil {
		return err
	}
	var said struct {
		Agent     struct{ Handle string }
		Workspace struct{ Name string }
		Next      string
	}
	if err := json.Unmarshal(raw, &said); err != nil {
		return err
	}
	fmt.Fprintf(r.out, "Connected as %s in %s.\n%s\n", said.Agent.Handle, said.Workspace.Name, said.Next)
	return nil
}
