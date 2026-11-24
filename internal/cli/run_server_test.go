package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// fakeQuadit answers quadit run as a server does by the contract
// (agent-runs-contract.md §4): GET /listen with wake and batch, a lease a
// chat can hold instead; POST /changes keeping each change and its id, a
// change sent again under its id answered as the first time, session.start
// refused for a stale lease or a second open run; PUT /cursors with the
// lease; GET /events of a task, held until one comes; GET /list/sessions
// and /list/projects; GET /me; DELETE /listening/{key}/runner. On demand it
// loses answers, refuses leases, answers as an older server, or cannot be
// reached at all.
type fakeQuadit struct {
	mu      sync.Mutex
	seq     int64
	lease   string
	chat    bool             // a chat holds the project's listener
	cursors map[string]int64 // each agent's listener's cursor, by its user id
	items   []fakeItem
	runs    []map[string]any
	events  []fakeEvent
	// changes are every change applied, in order; answered the first
	// answer to each change id.
	changes  []fakeChange
	answered map[string]string
	bodies   map[string]string // the change each applied id was, as sent
	acks     []fakeAck
	holds    []url.Values
	released []url.Values
	comments []map[string]any
	sent     map[string]int // how often each change id was sent
	calls    []string       // the writes, in the order they came: "session.start", "ack", "release", …
	changed  chan struct{}  // closed and made anew when an item or an event comes

	// On demand: answers lost after a change of this type is applied (that
	// many times), holds answered as an older server ("no_wake",
	// "bad_wake", "other_project"), nothing answered at all.
	lose        map[string]int
	oldServer   string
	unreachable bool
	failEvents  bool // GET /events answers 503
	// changesAway answers every change 503 before applying it; staleStart
	// refuses a session.start's lease; stopOnStart has a member stop a run
	// the moment it is made; refuseEnds refuses for good (403) an update
	// that ends a run; writeOnRunning is an event the agent emits (as its
	// program would) when a run goes running.
	changesAway    bool
	runsAway       bool   // GET /list/sessions answers 503
	runsAwayHits   int    // how often it did
	stopsHanded    int    // how often GET /events handed out a stop
	changesAwayFor string // the same, for one login's changes alone
	staleStart     bool
	stopOnStart    bool
	refuseEnds     bool
	writeOnRunning string
	beforeWrite    func() // called as each write (a change, an acknowledgment) arrives
	members        map[string]fakeMember
}

type fakeItem struct {
	Inner    int64  // the item's own seq as answered, when it is not Seq (a server that is wrong)
	For      string // the agent's user id; none: @claude's
	Seq      int64
	ID       string
	Type     string
	By       string
	ByAgent  bool
	Task     string
	Do, Why  string
	Decision string
}

type fakeEvent struct {
	Seq      int64          `json:"seq"`
	Type     string         `json:"type"`
	ActorID  string         `json:"actor_id"`
	EntityID string         `json:"entity_id"`
	Data     map[string]any `json:"data"`
	task     string
}

type fakeChange struct {
	ID   string
	Type string
	Args map[string]any
}

type fakeAck struct {
	Cursor string
	Seq    int64
	Lease  string
}

type fakeMember struct {
	Handle, Kind, UserID, Responsible string
	ReadOnly                          bool
}

// The fake server's workspace, project and members.
const (
	fakeWorkspaceID = "0199aaaa-0000-7000-8000-000000000001"
	fakeProjectID   = "0199aaaa-0000-7000-8000-0000000000aa"
	fakeAgentID     = "0199aaaa-0000-7000-8000-0000000000c1"
	fakeOwnerID     = "0199aaaa-0000-7000-8000-0000000000b1"
	agentToken      = "agent-token"
	codexToken      = "codex-token"
	fakeCodexID     = "0199aaaa-0000-7000-8000-0000000000c2"
)

func newFakeQuadit() *fakeQuadit {
	return &fakeQuadit{lease: testLease, seq: 1000, answered: map[string]string{}, lose: map[string]int{}, changed: make(chan struct{}),
		cursors: map[string]int64{}, sent: map[string]int{}, bodies: map[string]string{},
		members: map[string]fakeMember{
			agentToken:    {Handle: "@claude", Kind: "agent", UserID: fakeAgentID, Responsible: "@aram"},
			codexToken:    {Handle: "@codex", Kind: "agent", UserID: fakeCodexID, Responsible: "@aram"},
			"owner-token": {Handle: "@aram", Kind: "person", UserID: fakeOwnerID},
		}}
}

// wakeLocked wakes every request waiting for something new; f.mu is held.
func (f *fakeQuadit) wakeLocked() {
	close(f.changed)
	f.changed = make(chan struct{})
}

// addItem puts an item in the agent's inbox, and gives its seq.
func (f *fakeQuadit) addItem(it fakeItem) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	it.Seq = f.seq
	if it.ID == "" {
		it.ID = fmt.Sprintf("0199bbbb-0000-7000-8000-%012d", it.Seq)
	}
	if it.Type == "" {
		it.Type = "comment"
	}
	if it.By == "" {
		it.By = "@aram"
	}
	if it.Do == "" {
		it.Do, it.Why = wakeRun, "for_you"
	}
	if it.For == "" {
		it.For = fakeAgentID
	}
	f.items = append(f.items, it)
	f.wakeLocked()
	return it.Seq
}

// emitLocked appends an event; f.mu is held.
func (f *fakeQuadit) emitLocked(typ, actor, entity, task string, data map[string]any) int64 {
	f.seq++
	f.events = append(f.events, fakeEvent{Seq: f.seq, Type: typ, ActorID: actor, EntityID: entity, Data: data, task: task})
	f.wakeLocked()
	return f.seq
}

// agentWrites has the agent write on the task, as a program it runs does.
func (f *fakeQuadit) agentWrites(task, typ string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.emitLocked(typ, fakeAgentID, "x", task, map[string]any{})
}

// stopRun asks a run to stop, as session.stop does for a run whose machine
// holds the listener.
func (f *fakeQuadit) stopRun(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.runs {
		if row["id"] == id {
			row["stop_requested_at"] = time.Now().UnixMilli()
			f.emitLocked("session.updated", fakeOwnerID, id, row["task"].(string), map[string]any{"changes": map[string]any{"stop_requested_at": map[string]any{"to": row["stop_requested_at"]}}})
		}
	}
}

func (f *fakeQuadit) set(change func(f *fakeQuadit)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
	f.wakeLocked()
}

// run is a copy of a run's row by id, or nil.
func (f *fakeQuadit) run(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, row := range f.runs {
		if row["id"] == id {
			return deepCopy(row)
		}
	}
	return nil
}

// The fake's records are handed to a test as copies made under its lock,
// all the way down: a test never reads what a handler goes on using.

// allRuns are copies of the rows, in the order they were made.
func (f *fakeQuadit) allRuns() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return deepCopy(f.runs)
}

func (f *fakeQuadit) changeList() []fakeChange {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fakeChange, len(f.changes))
	for i, ch := range f.changes {
		out[i] = fakeChange{ID: ch.ID, Type: ch.Type, Args: deepCopy(ch.Args)}
	}
	return out
}

func (f *fakeQuadit) ackList() []fakeAck {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.acks)
}

func (f *fakeQuadit) holdList() []url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	return deepCopy(f.holds)
}

func (f *fakeQuadit) commentList() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return deepCopy(f.comments)
}

func (f *fakeQuadit) itemList() []fakeItem {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.items)
}

// deepCopy copies maps and slices all the way down; other values are
// copied as values are.
func deepCopy[T any](v T) T {
	return copyAny(any(v)).(T)
}

func copyAny(v any) any {
	switch v := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, x := range v {
			out[k] = copyAny(x)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = copyAny(x)
		}
		return out
	case []map[string]any:
		out := make([]map[string]any, len(v))
		for i, x := range v {
			out[i] = copyAny(x).(map[string]any)
		}
		return out
	case url.Values:
		out := make(url.Values, len(v))
		for k, x := range v {
			out[k] = slices.Clone(x)
		}
		return out
	case []url.Values:
		out := make([]url.Values, len(v))
		for i, x := range v {
			out[i] = copyAny(x).(url.Values)
		}
		return out
	}
	return v
}

// cursorAt is where @claude's listener's cursor stands.
func (f *fakeQuadit) cursorAt() int64 { return f.cursorOf(fakeAgentID) }

func (f *fakeQuadit) cursorOf(user string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cursors[user]
}

// count reads one of the fake's counters.
func (f *fakeQuadit) count(read func(f *fakeQuadit) int) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return read(f)
}

func (f *fakeQuadit) callList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeQuadit) sentCount(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[id]
}

func (f *fakeQuadit) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	unreachable := f.unreachable
	f.mu.Unlock()
	if unreachable {
		// A server away: the connection closes without an answer.
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				conn.Close()
				return
			}
		}
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	who, ok := f.members[token]
	f.mu.Unlock()
	if !ok {
		refuse(w, http.StatusUnauthorized, "unauthorized", "", "not signed in")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/w/-")
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && path == "/me":
		f.mu.Lock()
		seq := f.seq
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"handle": who.Handle, "kind": who.Kind, "user_id": who.UserID, "read_only": who.ReadOnly,
			"responsible": who.Responsible, "seq": seq, "workspace": map[string]any{"id": fakeWorkspaceID, "slug": "personal"}, "projects": []string{"SVA"}})
	case r.Method == http.MethodGet && path == "/list/projects":
		_, _ = io.WriteString(w, `{"projects":[{"id":"`+fakeProjectID+`","key":"SVA","name":"Samurai"}]}`)
	case r.Method == http.MethodGet && path == "/list/sessions":
		f.mu.Lock()
		away := f.runsAway
		f.mu.Unlock()
		if away {
			f.mu.Lock()
			f.runsAwayHits++
			f.mu.Unlock()
			refuse(w, http.StatusServiceUnavailable, "unavailable", "", "the runs are away")
			return
		}
		f.listRuns(w, r)
	case r.Method == http.MethodGet && path == "/listen":
		f.listen(w, r, who)
	case r.Method == http.MethodPut && strings.HasPrefix(path, "/cursors/"):
		f.ack(w, r, who, strings.TrimPrefix(path, "/cursors/"))
	case r.Method == http.MethodPost && path == "/changes":
		f.applyChanges(w, r, who)
	case r.Method == http.MethodGet && path == "/events":
		f.feed(w, r)
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/listening/") && strings.HasSuffix(path, "/runner"):
		f.mu.Lock()
		f.released = append(f.released, deepCopy(r.URL.Query()))
		f.calls = append(f.calls, "release")
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{"project":"SVA","released":true}`)
	default:
		refuse(w, http.StatusNotFound, "not_found", "", "no route "+path)
	}
}

func refuse(w http.ResponseWriter, status int, code, reason, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": code, "reason": reason, "message": message}})
}

func (f *fakeQuadit) listRuns(w http.ResponseWriter, r *http.Request) {
	task := r.URL.Query().Get("task")
	f.mu.Lock()
	var rows []map[string]any
	for _, row := range f.runs {
		if row["task"] == task {
			rows = append(rows, row)
		}
	}
	raw, _ := json.Marshal(map[string]any{"sessions": rows})
	f.mu.Unlock()
	_, _ = w.Write(raw)
}

// itemJSON is an item as GET /listen answers it.
func (it fakeItem) answer() map[string]any {
	inner := it.Seq
	if it.Inner != 0 {
		inner = it.Inner
	}
	return map[string]any{"seq": it.Seq, "line": fmt.Sprintf("#%d %s %s", it.Seq, it.Type, it.Task),
		"item": map[string]any{"id": it.ID, "seq": inner, "type": it.Type, "by": it.By, "by_agent": it.ByAgent, "task": it.Task, "title": it.Task + " Boss fight",
			"snippet": "please do it", "decision": it.Decision},
		"wake": map[string]any{"do": it.Do, "why": it.Why}}
}

func (f *fakeQuadit) listen(w http.ResponseWriter, r *http.Request, who fakeMember) {
	q := r.URL.Query()
	q.Set("token", who.Handle) // which login held
	deadline := time.Now().Add(30 * time.Millisecond)
	for {
		f.mu.Lock()
		f.holds = append(f.holds, deepCopy(q)) // a record of its own: the handler goes on using q
		if f.chat {
			f.mu.Unlock()
			refuse(w, http.StatusConflict, "conflict", "listening_elsewhere", "a chat listens to SVA")
			return
		}
		if q.Get("machine_id") != "" && (q.Get("machine_name") == "" || q.Get("folder") == "" || q.Get("program") == "") {
			f.mu.Unlock()
			refuse(w, http.StatusBadRequest, "invalid", "", "a runner's hold names its machine, folder and program")
			return
		}
		if q.Get("paused_until") != "" && q.Get("paused") != core.PauseUsageLimit {
			f.mu.Unlock()
			refuse(w, http.StatusBadRequest, "invalid", "", "paused_until is for a usage limit")
			return
		}
		if given := q.Get("lease"); given != "" && given != f.lease {
			f.mu.Unlock()
			refuse(w, http.StatusConflict, "conflict", "lease_stale", "that lease ended")
			return
		}
		answer := map[string]any{"lease": f.lease, "project": "SVA"}
		if f.oldServer == "other_project" {
			answer["project"] = "GS"
		}
		var head *fakeItem
		for i := range f.items {
			if f.items[i].Seq > f.cursors[who.UserID] && f.items[i].For == who.UserID {
				head = &f.items[i]
				break
			}
		}
		if head != nil {
			maps.Copy(answer, head.answer())
			switch f.oldServer {
			case "no_wake":
				delete(answer, "wake")
			case "bad_wake":
				answer["wake"] = map[string]any{"do": "launch", "why": "for_you"}
			}
			if q.Get("batch") == "1" {
				var batch []map[string]any
				for _, it := range f.items {
					if it.Seq > head.Seq && it.Task == head.Task && it.For == who.UserID && len(batch) < 20 {
						batch = append(batch, it.answer())
					}
				}
				answer["batch"] = batch
			}
		}
		changed := f.changed
		f.mu.Unlock()
		if head != nil || time.Now().After(deadline) {
			_ = json.NewEncoder(w).Encode(answer)
			return
		}
		select {
		case <-changed:
		case <-time.After(time.Until(deadline)):
		case <-r.Context().Done():
			return
		}
		f.mu.Lock()
		f.holds = f.holds[:len(f.holds)-1] // one hold, asked again
		f.mu.Unlock()
	}
}

func (f *fakeQuadit) ack(w http.ResponseWriter, r *http.Request, who fakeMember, cursor string) {
	f.mu.Lock()
	hook := f.beforeWrite
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	var body struct {
		Seq   int64
		Lease string
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	defer f.mu.Unlock()
	if body.Lease != f.lease || f.chat {
		refuse(w, http.StatusConflict, "conflict", "lease_stale", "that lease ended")
		return
	}
	f.acks = append(f.acks, fakeAck{Cursor: cursor, Seq: body.Seq, Lease: body.Lease})
	f.calls = append(f.calls, "ack")
	f.cursors[who.UserID] = max(f.cursors[who.UserID], body.Seq)
	f.wakeLocked()
	_, _ = io.WriteString(w, `{}`)
}

func (f *fakeQuadit) applyChanges(w http.ResponseWriter, r *http.Request, who fakeMember) {
	f.mu.Lock()
	hook := f.beforeWrite
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	var body struct {
		Changes []fakeChange `json:"changes"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ch := body.Changes[0]
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent[ch.ID]++
	if f.changesAway || f.changesAwayFor == who.Handle {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"code":"unavailable","message":"the server is busy"}}`)
		return
	}
	sentAs, _ := json.Marshal(ch)
	if first, ok := f.bodies[ch.ID]; ok && first != string(sentAs) {
		// As the server does: a change id used again for another change.
		refuse(w, http.StatusConflict, "conflict", "", "change id "+ch.ID+" was already used for a different change")
		return
	}
	if first, ok := f.answered[ch.ID]; ok {
		_, _ = io.WriteString(w, first)
		return
	}
	status, answer := f.applyLocked(ch, who)
	if status != http.StatusOK {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
		return
	}
	f.changes = append(f.changes, ch)
	f.bodies[ch.ID] = string(sentAs)
	f.calls = append(f.calls, ch.Type)
	f.answered[ch.ID] = answer
	if f.lose[ch.Type] > 0 {
		f.lose[ch.Type]--
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"code":"unavailable","message":"the answer was lost"}}`)
		return
	}
	_, _ = io.WriteString(w, answer)
}

// applyLocked applies one change as the server's engine does what the
// runner needs of it; f.mu is held.
func (f *fakeQuadit) applyLocked(ch fakeChange, who fakeMember) (int, string) {
	bad := func(status int, code, reason, message string) (int, string) {
		raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "reason": reason, "message": message}})
		return status, string(raw)
	}
	a := ch.Args
	str := func(k string) string { s, _ := a[k].(string); return s }
	var ref string
	var seq int64
	switch ch.Type {
	case "session.start":
		if str("lease") != f.lease || f.chat || f.staleStart {
			return bad(http.StatusConflict, "conflict", "lease_stale", "that lease is not the listener's")
		}
		if str("state") == "waiting" {
			for _, row := range f.runs {
				if row["task"] == str("task") && row["agent_id"] == who.UserID && (row["state"] == "waiting" || row["state"] == "running") {
					return bad(http.StatusConflict, "conflict", "run_open", fmt.Sprintf("%s already has a run open on %s, on %s (run %s)", who.Handle, row["task"], row["machine_name"], row["id"]))
				}
			}
		}
		row := map[string]any{"agent_id": who.UserID, "started_at": time.Now().UnixMilli()}
		for k, v := range a {
			if k != "lease" {
				row[k] = v
			}
		}
		if str("state") == "not_started" {
			row["ended_at"] = row["started_at"]
		}
		f.runs = append(f.runs, row)
		ref = str("id")
		seq = f.emitLocked("session.created", who.UserID, ref, str("task"), map[string]any{"row": row})
		if f.stopOnStart {
			row["stop_requested_at"] = time.Now().UnixMilli()
			f.emitLocked("session.updated", fakeOwnerID, ref, str("task"), map[string]any{"changes": map[string]any{"stop_requested_at": map[string]any{"to": row["stop_requested_at"]}}})
		}
	case "session.update":
		var row map[string]any
		for _, r := range f.runs {
			if r["id"] == str("id") {
				row = r
			}
		}
		if row == nil {
			return bad(http.StatusNotFound, "not_found", "", "session not found")
		}
		state, moving := a["state"].(string)
		if ended(row["state"].(string)) {
			for _, k := range []string{"reason", "add_steps", "items_through", "resets_at", "program_session", "fresh", "title"} {
				if _, ok := a[k]; ok {
					return bad(http.StatusBadRequest, "invalid", "", k+": this run ended")
				}
			}
			if moving && state != row["state"] {
				return bad(http.StatusBadRequest, "invalid", "", "this run ended: it cannot become "+state)
			}
		}
		if f.refuseEnds && ended(state) {
			return bad(http.StatusForbidden, "forbidden", "", "this run is not yours to end")
		}
		if _, ok := a["items_through"]; ok && (state != "running" || row["state"] != "waiting") {
			return bad(http.StatusBadRequest, "invalid", "", "items_through comes with the move to running")
		}
		if _, ok := a["resets_at"]; ok && a["reason"] != core.RunUsageLimit {
			return bad(http.StatusBadRequest, "invalid", "", "resets_at is for a usage limit")
		}
		if _, ok := a["fresh"]; ok && a["program_session"] == nil {
			return bad(http.StatusBadRequest, "invalid", "", "fresh comes with program_session")
		}
		if steps, ok := a["add_steps"].([]any); ok {
			for _, st := range steps {
				if m, ok := st.(map[string]any); !ok || m["tool"] == "" || m["tool"] == nil {
					return bad(http.StatusBadRequest, "invalid", "", "a step is an object with its tool")
				}
			}
		}
		if moving && a["reason"] == nil {
			delete(row, "reason") // a state change without a reason clears it
		}
		changes := map[string]any{}
		for k, v := range a {
			switch k {
			case "id", "fresh":
			case "add_steps":
				steps, _ := row["steps"].([]any)
				row["steps"] = append(steps, v.([]any)...)
			default:
				row[k] = v
				changes[k] = map[string]any{"to": v}
			}
		}
		if a["state"] == "running" {
			row["accepted_at"] = time.Now().UnixMilli()
		}
		ref = str("id")
		seq = f.emitLocked("session.updated", who.UserID, ref, row["task"].(string), map[string]any{"changes": changes})
		if a["state"] == "running" && f.writeOnRunning != "" {
			f.emitLocked(f.writeOnRunning, who.UserID, "x", row["task"].(string), map[string]any{})
		}
	case "comment.create":
		f.comments = append(f.comments, a)
		ref = fmt.Sprintf("comment-%d", len(f.comments))
		seq = f.emitLocked("comment.created", who.UserID, ref, str("task"), map[string]any{"row": map[string]any{"session_id": a["session"]}})
	default:
		return bad(http.StatusBadRequest, "invalid", "", "no change "+ch.Type)
	}
	raw, _ := json.Marshal(map[string]any{"results": []map[string]any{{"change_id": ch.ID, "type": ch.Type, "seq": seq, "ref": ref}}})
	return http.StatusOK, string(raw)
}

func (f *fakeQuadit) feed(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	after, _ := strconv.ParseInt(q.Get("after"), 10, 64)
	wait, _ := strconv.Atoi(q.Get("wait"))
	types := strings.Split(q.Get("types"), ",")
	deadline := time.Now().Add(min(time.Duration(wait)*time.Second, 2*time.Second))
	for {
		f.mu.Lock()
		if f.failEvents {
			f.mu.Unlock()
			refuse(w, http.StatusServiceUnavailable, "unavailable", "", "the feed is away")
			return
		}
		var out []fakeEvent
		for _, ev := range f.events {
			if ev.Seq > after && ev.task == q.Get("task") && (q.Get("types") == "" || slices.Contains(types, ev.Type)) {
				out = append(out, ev)
			}
		}
		seq := max(f.seq, after)
		changed := f.changed
		f.mu.Unlock()
		if len(out) > 0 || wait == 0 || time.Now().After(deadline) {
			if out == nil {
				out = []fakeEvent{}
			}
			for _, ev := range out {
				if changes, ok := ev.Data["changes"].(map[string]any); ok && changes["stop_requested_at"] != nil {
					f.mu.Lock()
					f.stopsHanded++
					f.mu.Unlock()
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"events": out, "seq": seq, "more": false})
			return
		}
		select {
		case <-changed:
		case <-time.After(time.Until(deadline)):
		case <-r.Context().Done():
			return
		}
	}
}

// serveFake serves a fake server on a free port of this computer.
func serveFake(t *testing.T, f *fakeQuadit) string {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestTheRunnerReadsTheAnswersOfTheServer(t *testing.T) {
	f := newFakeQuadit()
	api := entryAPI{c: &Client{URL: serveFake(t, f), Token: agentToken, HTTP: http.DefaultClient}}
	ctx := context.Background()
	f.addItem(fakeItem{Task: "SVA-12", Decision: "0199cccc-0000-7000-8000-000000000001", Type: "picked"})
	f.addItem(fakeItem{Task: "SVA-12", Do: wakeRefuse, Why: "not_responsible", By: "@mia"})

	t.Run("a hold gives the head, its wake and the batch", func(t *testing.T) {
		ans, err := api.hold(ctx, holdAsk{project: "SVA", wait: time.Second, batch: true, machineID: "3f9c0a7d5e21b864", machineName: "Test Mac", folder: "~/devel/game", program: "claude"})
		if err != nil {
			t.Fatal(err)
		}
		if ans.Item == nil || ans.Item.Decision == "" || !ans.Wake.understood() || len(ans.Batch) != 1 || ans.Batch[0].Wake.Do != wakeRefuse {
			t.Fatalf("answer %+v", ans)
		}
		q := f.holdList()[0]
		if q.Get("by") != runnerBy || q.Get("machine_id") != "3f9c0a7d5e21b864" || q.Get("batch") != "1" {
			t.Fatalf("the hold asked %v", q)
		}
	})
	t.Run("a task's events are read up to a position, every page", func(t *testing.T) {
		f.agentWrites("SVA-12", "comment.created")
		me, err := api.me(ctx)
		if err != nil {
			t.Fatal(err)
		}
		f.agentWrites("SVA-12", "task.updated")
		evs, err := api.taskEvents(ctx, "SVA-12", 0, me.Seq)
		if err != nil || len(evs) != 1 || evs[0].Type != "comment.created" {
			t.Fatalf("events %+v, %v", evs, err)
		}
	})
	t.Run("a refusal of the lease is told apart from a server away", func(t *testing.T) {
		f.set(func(f *fakeQuadit) { f.chat = true })
		_, err := api.hold(ctx, holdAsk{project: "SVA", wait: time.Second})
		if !leaseLost(err) || temporary(err) {
			t.Fatalf("a chat's lease: %v", err)
		}
		f.set(func(f *fakeQuadit) { f.chat, f.unreachable = false, true })
		_, err = api.hold(ctx, holdAsk{project: "SVA", wait: time.Second})
		if leaseLost(err) || !temporary(err) {
			t.Fatalf("a server away: %v", err)
		}
	})
}
