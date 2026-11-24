// What `quadit run` asks of a server, for one entry, through the entry's
// own login: the runner's hold of the project's listener, who the login
// is, its projects, a task's runs and events, the writes, and letting the
// project go. The answers are read in the forms the runner trusts; what is
// not of its form is not acted on.

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"time"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// entryAPI is the server as one entry reaches it. Each request is made on
// a copy of the client, so requests from the entry's goroutines never
// share what a client remembers of its last answer.
type entryAPI struct{ c *Client }

// client is a copy of the entry's client for one request.
func (api entryAPI) client() *Client {
	c := *api.c
	return &c
}

// runnerBy is what the runner says it is to whoever asks what listens.
const runnerBy = "Quadit's runner"

// holdAsk is one hold of the project's listener as a runner: with its
// lease, for how long, whether to have the other items of the head's task
// too, and the runner's mark (machine, folder, program, pause).
type holdAsk struct {
	project     string // the project's key
	lease       string
	wait        time.Duration
	batch       bool
	machineID   string
	machineName string
	folder      string // the folder's label
	program     string
	version     string
	paused      string
	pausedUntil int64 // ms, with paused usage_limit
}

// held is an answer of GET /listen to a runner.
type held struct {
	Lease   string      `json:"lease"`
	Project string      `json:"project"`
	Seq     int64       `json:"seq"`
	Item    *listenItem `json:"item"`
	Line    string      `json:"line"`
	Wake    *wake       `json:"wake"`
	Batch   []heldItem  `json:"batch"`
}

// heldItem is one more item of the head's task, as a batch answers it.
type heldItem struct {
	Seq  int64       `json:"seq"`
	Item *listenItem `json:"item"`
	Line string      `json:"line"`
	Wake *wake       `json:"wake"`
}

// wake is what the server says a runner does with an item: start a run
// ("run"), acknowledge it ("ack"), or record that it did not start and
// acknowledge it ("refuse"), and why.
type wake struct {
	Do  string `json:"do"`
	Why string `json:"why"`
}

// The things a wake says to do.
const (
	wakeRun    = "run"
	wakeAck    = "ack"
	wakeRefuse = "refuse"
)

// understood reports whether the runner can act on w: a do it knows. Why
// an item is acknowledged does not matter (any why, known or not, is a
// plain acknowledgment); a refusal's why goes on the row, so it must have
// a reason's form.
func (w *wake) understood() bool {
	switch {
	case w == nil:
		return false
	case w.Do == wakeRefuse:
		return kindForm.MatchString(w.Why)
	}
	return w.Do == wakeRun || w.Do == wakeAck
}

// hold holds the listener as ask says.
func (api entryAPI) hold(ctx context.Context, ask holdAsk) (held, error) {
	q := url.Values{
		"project": {ask.project}, "by": {runnerBy}, "wait": {strconv.Itoa(max(int(ask.wait.Round(time.Second).Seconds()), 1))},
		"machine_id": {ask.machineID}, "machine_name": {ask.machineName}, "folder": {ask.folder},
		"program": {ask.program}, "program_version": {ask.version}, "paused": {ask.paused},
	}
	if ask.lease != "" {
		q.Set("lease", ask.lease)
	}
	if ask.batch {
		q.Set("batch", "1")
	}
	if ask.pausedUntil > 0 {
		q.Set("paused_until", strconv.FormatInt(ask.pausedUntil, 10))
	}
	ctx, cancel := context.WithTimeout(ctx, ask.wait+holdSlack)
	defer cancel()
	var answer held
	raw, err := api.client().JSON(ctx, "/listen", q)
	if err != nil {
		return answer, err
	}
	return answer, json.Unmarshal(raw, &answer)
}

// whoAmI is what GET /me says of the login.
type whoAmI struct {
	Handle      string `json:"handle"`
	Kind        string `json:"kind"`
	UserID      string `json:"user_id"`
	ReadOnly    bool   `json:"read_only"`
	Responsible string `json:"responsible"`
	Seq         int64  `json:"seq"`
	Workspace   struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
	} `json:"workspace"`
	Projects []string `json:"projects"`
}

func (api entryAPI) me(ctx context.Context) (whoAmI, error) {
	var me whoAmI
	raw, err := api.client().JSON(ctx, "/me", nil)
	if err != nil {
		return me, err
	}
	return me, json.Unmarshal(raw, &me)
}

// waitingAnswer is what GET /listening/{key}/waiting answers: the tasks a
// runner set up now would start, the first five named.
type waitingAnswer struct {
	Agent   string `json:"agent"`
	Project string `json:"project"`
	Runs    int    `json:"runs"`
	Tasks   []struct {
		Key   string `json:"key"`
		Title string `json:"title"`
	} `json:"tasks"`
}

// waiting is what a runner set up now for the project would start, and
// the answer as the server wrote it.
func (api entryAPI) waiting(ctx context.Context, project string) (waitingAnswer, []byte, error) {
	var answer waitingAnswer
	raw, err := api.client().JSON(ctx, "/listening/"+url.PathEscape(project)+"/waiting", nil)
	if err != nil {
		return answer, nil, err
	}
	return answer, raw, json.Unmarshal(raw, &answer)
}

// projectRow is a project as GET /list/projects gives it.
type projectRow struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	Name string `json:"name"`
}

func (api entryAPI) projects(ctx context.Context) ([]projectRow, error) {
	var answer struct {
		Projects []projectRow `json:"projects"`
	}
	raw, err := api.client().JSON(ctx, "/list/projects", nil)
	if err != nil {
		return nil, err
	}
	return answer.Projects, json.Unmarshal(raw, &answer)
}

// runRow is a run as GET /list/sessions gives it, with what the runner
// reads of it.
type runRow struct {
	ID              string `json:"id"`
	AgentID         string `json:"agent_id"`
	State           string `json:"state"`
	MachineID       string `json:"machine_id"`
	ItemsThrough    int64  `json:"items_through"`
	AcceptedAt      int64  `json:"accepted_at"`
	StopRequestedAt int64  `json:"stop_requested_at"`
}

// sessionsPage is how many runs one read of a task's runs asks for.
const sessionsPage = 200

// eachRun reads the runs of a task, a page at a time, until each says to
// stop or the list ends.
func (api entryAPI) eachRun(ctx context.Context, task string, each func(runRow) (stop bool)) error {
	for offset := 0; ; offset += sessionsPage {
		var answer struct {
			Sessions []runRow `json:"sessions"`
		}
		q := url.Values{"task": {task}, "limit": {strconv.Itoa(sessionsPage)}, "offset": {strconv.Itoa(offset)}}
		raw, err := api.client().JSON(ctx, "/list/sessions", q)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &answer); err != nil {
			return err
		}
		if slices.ContainsFunc(answer.Sessions, each) || len(answer.Sessions) < sessionsPage {
			return nil
		}
	}
}

// runRowOf is the run's own row, read again.
func (api entryAPI) runRowOf(ctx context.Context, task, run string) (runRow, bool, error) {
	var found runRow
	ok := false
	err := api.eachRun(ctx, task, func(row runRow) bool {
		if row.ID == run {
			found, ok = row, true
		}
		return ok
	})
	return found, ok, err
}

// feedEvent is an event of the feed, with what the runner reads of it.
type feedEvent struct {
	Seq      int64  `json:"seq"`
	Type     string `json:"type"`
	ActorID  string `json:"actor_id"`
	EntityID string `json:"entity_id"`
	Data     struct {
		Rule    string                     `json:"rule"`
		Changes map[string]json.RawMessage `json:"changes"`
		Row     struct {
			SessionID string `json:"session_id"`
		} `json:"row"`
	} `json:"data"`
}

// feedPage is one answer of GET /events.
type feedPage struct {
	Events []feedEvent `json:"events"`
	Seq    int64       `json:"seq"`
	More   bool        `json:"more"`
}

// events reads a task's events after a position, of the types given (all
// for none), held up to wait for one to come.
func (api entryAPI) events(ctx context.Context, task, types string, after int64, wait time.Duration) (feedPage, error) {
	q := url.Values{"task": {task}, "after": {strconv.FormatInt(after, 10)}}
	if types != "" {
		q.Set("types", types)
	}
	if wait > 0 {
		q.Set("wait", strconv.Itoa(max(int(wait.Round(time.Second).Seconds()), 1)))
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, wait+holdSlack)
		defer cancel()
	}
	var page feedPage
	raw, err := api.client().JSON(ctx, "/events", q)
	if err != nil {
		return page, err
	}
	return page, json.Unmarshal(raw, &page)
}

// taskEvents are a task's events after one position up to and including
// another, every page of them.
func (api entryAPI) taskEvents(ctx context.Context, task string, after, through int64) ([]feedEvent, error) {
	var all []feedEvent
	for after < through {
		page, err := api.events(ctx, task, "", after, 0)
		if err != nil {
			return nil, err
		}
		for _, ev := range page.Events {
			if ev.Seq <= through {
				all = append(all, ev)
			}
		}
		if !page.More || page.Seq <= after {
			break
		}
		after = page.Seq
	}
	return all, nil
}

// seqNow is where the workspace's feed stands now.
func (api entryAPI) seqNow(ctx context.Context) (int64, error) {
	me, err := api.me(ctx)
	return me.Seq, err
}

// change sends one change under its id, once: the outbox sends it again.
func (api entryAPI) change(ctx context.Context, changeID, typ string, args map[string]any) (Result, error) {
	body := plainjson.Marshal(map[string]any{"changes": []map[string]any{{"id": changeID, "type": typ, "args": args}}})
	raw, err := api.client().workspaceRequest(ctx, apiRequest{method: http.MethodPost, path: "/changes", body: bytes.NewReader(body), contentType: "application/json", accept: "application/json"})
	if err != nil {
		return Result{}, err
	}
	var answer struct {
		Results []Result `json:"results"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || len(answer.Results) == 0 {
		return Result{}, fmt.Errorf("unexpected answer: %s", raw)
	}
	return answer.Results[0], nil
}

// acknowledge moves the project listener's cursor to seq, with its lease.
func (api entryAPI) acknowledge(ctx context.Context, cursor string, seq int64, lease string) error {
	body := plainjson.Marshal(map[string]any{"seq": seq, "lease": lease})
	_, err := api.client().workspaceRequest(ctx, apiRequest{method: http.MethodPut, path: "/cursors/" + url.PathEscape(cursor), body: bytes.NewReader(body), contentType: "application/json"})
	return err
}

// release lets the project's runner go: the mark of this machine cleared,
// its lease ended.
func (api entryAPI) release(ctx context.Context, project, machineID string) error {
	_, err := api.client().workspaceRequest(ctx, apiRequest{method: http.MethodDelete, path: "/listening/" + url.PathEscape(project) + "/runner", query: url.Values{"machine_id": {machineID}}})
	return err
}

// refusalOf is the server's refusal in err, if it is one.
func refusalOf(err error) (*APIError, bool) {
	var ae *APIError
	return ae, errors.As(err, &ae)
}

// temporary reports whether err may go away by itself: the server or the
// network away, a request timed out, too many requests.
func temporary(err error) bool {
	ae, ok := refusalOf(err)
	if !ok {
		return true
	}
	return ae.Status == http.StatusRequestTimeout || ae.Status == http.StatusTooManyRequests || ae.Status >= 500
}

// serverAway reports whether err says the server is away: not reached at
// all (refused, timed out, no route: the client's transport error), or an
// answer that it is busy or failing (408, 429, 5xx); not a refusal it gave,
// nor a fault of this computer's.
func serverAway(err error) bool {
	if _, answered := refusalOf(err); answered {
		return temporary(err)
	}
	var transport *url.Error
	return errors.As(err, &transport)
}

// refusalReason is the reason of the server's refusal in err, or "".
func refusalReason(err error) string {
	if ae, ok := refusalOf(err); ok {
		return ae.Reason
	}
	return ""
}

// accessRefused reports whether err says the login lost its access: a
// definitive refusal (401, 403), not a server away.
func accessRefused(err error) bool {
	ae, ok := refusalOf(err)
	return ok && (ae.Status == http.StatusUnauthorized || ae.Status == http.StatusForbidden)
}

// leaseLost reports whether err says another session holds the listener.
func leaseLost(err error) bool {
	ae, ok := refusalOf(err)
	return ok && (ae.Reason == "listening_elsewhere" || ae.Reason == "lease_stale")
}
