package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// errBgOutage is what a faulty store answers with: a database that is
// briefly unreachable, not a row that is missing.
var errBgOutage = errors.New("the database is briefly unreachable")

// bgFault makes the next calls of one store method on one table fail.
type bgFault struct {
	op    string // Get, List, Count, Update, Delete, Events, Insert
	table string // the table name, or for Get, List and Insert the row's type name (Webhook)
	// match narrows the calls that fail; nil fails them all.
	match func(set map[string]any, where []store.Cond) bool
	times int // how many calls fail; then the fault is spent

	hits int
}

// bgFaults is the set of armed faults a bgFaultStore checks every call against.
type bgFaults struct {
	mu   sync.Mutex
	list []*bgFault
}

func (fs *bgFaults) check(op, table string, set map[string]any, where []store.Cond) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for _, f := range fs.list {
		if f.op == op && f.table == table && f.hits < f.times && (f.match == nil || f.match(set, where)) {
			f.hits++
			return errBgOutage
		}
	}
	return nil
}

// arm adds a fault and returns a function that says how often it fired.
func (fs *bgFaults) arm(f bgFault) func() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.list = append(fs.list, &f)
	return func() int {
		fs.mu.Lock()
		defer fs.mu.Unlock()
		return f.hits
	}
}

// bgFaultStore is a store whose reads and writes can be made to fail, through
// the store itself and through the workspace-bound DBs it hands out.
type bgFaultStore struct {
	store.Store
	faults *bgFaults
}

func newBgFaultStore(t *testing.T) bgFaultStore {
	return bgFaultStore{Store: testdb.SQLite(t), faults: &bgFaults{}}
}

// bgTypeName is the name of the row type behind a pointer to a row or a slice.
func bgTypeName(dst any) string {
	t := reflect.TypeOf(dst)
	for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice {
		t = t.Elem()
	}
	return t.Name()
}

// bgWhereHas reports whether the conditions say col = val.
func bgWhereHas(where []store.Cond, col string, val any) bool {
	for _, c := range where {
		if c.Col == col && c.Op == "=" && c.Val == val {
			return true
		}
	}
	return false
}

func (s bgFaultStore) In(workspaceID string) store.DB {
	return bgFaultDB{DB: s.Store.In(workspaceID), faults: s.faults}
}

func (s bgFaultStore) Get(ctx context.Context, dst any, where ...store.Cond) error {
	return bgFaultDB{DB: s.Store, faults: s.faults}.Get(ctx, dst, where...)
}

func (s bgFaultStore) List(ctx context.Context, dst any, q store.Q) error {
	return bgFaultDB{DB: s.Store, faults: s.faults}.List(ctx, dst, q)
}

func (s bgFaultStore) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	return bgFaultDB{DB: s.Store, faults: s.faults}.Count(ctx, table, where...)
}

func (s bgFaultStore) Insert(ctx context.Context, row any) error {
	return bgFaultDB{DB: s.Store, faults: s.faults}.Insert(ctx, row)
}

func (s bgFaultStore) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	return bgFaultDB{DB: s.Store, faults: s.faults}.Update(ctx, table, set, where...)
}

func (s bgFaultStore) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	return bgFaultDB{DB: s.Store, faults: s.faults}.Delete(ctx, table, where...)
}

// bgFaultDB is a store.DB that fails the calls its faults name.
type bgFaultDB struct {
	store.DB
	faults *bgFaults
}

func (d bgFaultDB) Get(ctx context.Context, dst any, where ...store.Cond) error {
	if err := d.faults.check("Get", bgTypeName(dst), nil, where); err != nil {
		return err
	}
	return d.DB.Get(ctx, dst, where...)
}

func (d bgFaultDB) List(ctx context.Context, dst any, q store.Q) error {
	if err := d.faults.check("List", bgTypeName(dst), nil, q.Where); err != nil {
		return err
	}
	return d.DB.List(ctx, dst, q)
}

func (d bgFaultDB) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if err := d.faults.check("Count", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Count(ctx, table, where...)
}

func (d bgFaultDB) Insert(ctx context.Context, row any) error {
	if err := d.faults.check("Insert", bgTypeName(row), nil, nil); err != nil {
		return err
	}
	return d.DB.Insert(ctx, row)
}

func (d bgFaultDB) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	if err := d.faults.check("Update", table, set, where); err != nil {
		return 0, err
	}
	return d.DB.Update(ctx, table, set, where...)
}

func (d bgFaultDB) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	if err := d.faults.check("Delete", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Delete(ctx, table, where...)
}

func (d bgFaultDB) Tasks(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	if err := d.faults.check("Tasks", "tasks", nil, nil); err != nil {
		return nil, err
	}
	return d.DB.Tasks(ctx, f)
}

func (d bgFaultDB) Events(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	if err := d.faults.check("Events", "events", nil, nil); err != nil {
		return nil, err
	}
	return d.DB.Events(ctx, f)
}

// bgLogBuffer collects what servers made after it is set up log, for a test
// to wait for a line.
type bgLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *bgLogBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *bgLogBuffer) has(text string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Contains(l.buf.String(), text)
}

// bgCaptureLogs sends the default logger, which a server made without its
// own logs to, into a buffer until the test ends.
func bgCaptureLogs(t *testing.T) *bgLogBuffer {
	t.Helper()
	logs := &bgLogBuffer{}
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })
	return logs
}

// workspaceID is the id of the site's one workspace.
func bgWorkspaceID(t *testing.T, st store.Store) string {
	t.Helper()
	var wss []core.Workspace
	if err := st.List(context.Background(), &wss, store.Q{}); err != nil || len(wss) != 1 {
		t.Fatalf("workspaces: %v %v", wss, err)
	}
	return wss[0].ID
}

// bgDeliveryOf is the one delivery made to a webhook.
func bgDeliveryOf(t *testing.T, st store.Store, hookID string) core.WebhookDelivery {
	t.Helper()
	var list []core.WebhookDelivery
	if err := st.List(context.Background(), &list, store.Where(store.Eq("webhook_id", hookID))); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		return core.WebhookDelivery{}
	}
	return list[0]
}

func TestADeliveryOutlivesABriefOutage(t *testing.T) {
	t.Run("a webhook that cannot be read for a moment is not given up", func(t *testing.T) {
		logs := bgCaptureLogs(t)
		st := newBgFaultStore(t)
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		rcv := newReceiver(t, "")
		hook := s.change(s.owner, "", "webhook.create", M{"name": "tasks", "url": rcv.srv.URL, "event_types": []string{"task.*"}})["ref"].(string)
		fired := st.faults.arm(bgFault{op: "Get", table: "Webhook", times: 1,
			match: func(_ map[string]any, where []store.Cond) bool { return bgWhereHas(where, "id", hook) }})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Dock crane"})
		eventually(t, "the delivery to fail on its webhook, and to be given up or kept", func() bool {
			return fired() == 1 && (bgDeliveryOf(t, st.Store, hook).State == "dead" || logs.has("webhook delivery: reading its webhook"))
		})
		if d := bgDeliveryOf(t, st.Store, hook); d.State != "pending" {
			t.Fatalf("after a failed read the delivery is %q (%s), want it pending for another try", d.State, d.Error)
		}
	})
	t.Run("a sent delivery is recorded though the first write fails", func(t *testing.T) {
		st := newBgFaultStore(t)
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		rcv := newReceiver(t, "")
		hook := s.change(s.owner, "", "webhook.create", M{"name": "tasks", "url": rcv.srv.URL, "event_types": []string{"task.*"}})["ref"].(string)
		fired := st.faults.arm(bgFault{op: "Update", table: "webhook_deliveries", times: 1,
			match: func(set map[string]any, _ []store.Cond) bool { return set["state"] == "ok" }})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Dock crane"})
		eventually(t, "the delivery to be recorded as done", func() bool { return bgDeliveryOf(t, st.Store, hook).State == "ok" })
		if fired() != 1 || rcv.types() != "task.created" {
			t.Fatalf("fault fired %d times; receiver got %q", fired(), rcv.types())
		}
	})
}

func TestAJobOutlivesABriefOutage(t *testing.T) {
	// queueJob puts a notify job for an inbox item in the queue, due now.
	queueJob := func(t *testing.T, st store.Store, jobID, wsID, itemID string) {
		t.Helper()
		now := time.Now().UnixMilli()
		j := core.Job{ID: jobID, Kind: "notify", WorkspaceID: wsID, Payload: []byte(`{"id":"` + itemID + `"}`), RunAt: now, CreatedAt: now}
		if err := st.Insert(context.Background(), j); err != nil {
			t.Fatal(err)
		}
	}
	jobOf := func(t *testing.T, st store.Store, jobID string) core.Job {
		t.Helper()
		var j core.Job
		if err := st.Get(context.Background(), &j, store.Eq("id", jobID)); err != nil {
			t.Fatal(err)
		}
		return j
	}
	t.Run("a job that ran is recorded though the first write fails", func(t *testing.T) {
		st := newBgFaultStore(t)
		newSite(t, st)
		job := id.New()
		fired := st.faults.arm(bgFault{op: "Update", table: "jobs", times: 1,
			match: func(set map[string]any, where []store.Cond) bool {
				_, done := set["done_at"]
				return done && bgWhereHas(where, "id", job)
			}})
		queueJob(t, st.Store, job, bgWorkspaceID(t, st.Store), "an item that is gone")
		eventually(t, "the job to be recorded as done", func() bool { return jobOf(t, st.Store, job).DoneAt != 0 })
		if fired() != 1 {
			t.Fatalf("fault fired %d times", fired())
		}
	})
	t.Run("an inbox item that cannot be read for a moment is tried again", func(t *testing.T) {
		st := newBgFaultStore(t)
		newSite(t, st)
		item := id.New()
		st.faults.arm(bgFault{op: "Get", table: "Notification", times: 1,
			match: func(_ map[string]any, where []store.Cond) bool { return bgWhereHas(where, "id", item) }})
		job := id.New()
		queueJob(t, st.Store, job, bgWorkspaceID(t, st.Store), item)
		eventually(t, "the job to run once", func() bool { j := jobOf(t, st.Store, job); return j.DoneAt != 0 || j.Error != "" })
		if j := jobOf(t, st.Store, job); j.DoneAt != 0 || !strings.Contains(j.Error, errBgOutage.Error()) {
			t.Fatalf("after a failed read the job is done at %d with error %q; want it waiting to be tried again", j.DoneAt, j.Error)
		}
		eventually(t, "the job to be done on its second try", func() bool { return jobOf(t, st.Store, job).DoneAt != 0 })
	})
}

// bgIDIs matches the calls about one row.
func bgIDIs(rowID string) func(map[string]any, []store.Cond) bool {
	return func(_ map[string]any, where []store.Cond) bool { return bgWhereHas(where, "id", rowID) }
}

func TestAReadThatFailsIsNotAnsweredAsNotFound(t *testing.T) {
	logs := bgCaptureLogs(t)
	st := newBgFaultStore(t)
	s := newSite(t, st)
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	var ready, started struct{ ID string }
	s.call(s.owner, "", "POST", w+"/files?name=notes.txt", []byte("hello"), 201, &ready)
	s.call(s.owner, "", "POST", w+"/files?name=clip.bin&size=10", []byte("1234"), 201, &started)
	var made struct{ ID string }
	s.call(s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &made)
	rcv := newReceiver(t, "")
	hook := s.change(s.owner, "", "webhook.create", M{"name": "tasks", "url": rcv.srv.URL, "event_types": []string{"never.matches"}})["ref"].(string)
	repeat := id.New()

	cases := []struct {
		name         string
		method, path string
		body         any
		storeFault   bgFault
	}{
		{"the next part of an upload", "PATCH", w + "/files/" + started.ID + "?offset=4", []byte("567890"),
			bgFault{op: "Get", table: "File", match: bgIDIs(started.ID)}},
		{"an upload started again with its own id", "POST", w + "/files?name=again.txt&id=" + repeat, []byte("x"),
			bgFault{op: "Get", table: "File", match: bgIDIs(repeat)}},
		{"an import of an uploaded file", "POST", w + "/import", M{"kind": "markdown", "file": ready.ID},
			bgFault{op: "Get", table: "File", match: bgIDIs(ready.ID)}},
		{"a backup's download", "GET", "/api/v1/admin/backups/" + made.ID + "/download", nil,
			bgFault{op: "Get", table: "Backup", match: bgIDIs(made.ID)}},
		{"a restore from a backup", "POST", "/api/v1/admin/backups/" + made.ID + "/restore-item", M{"workspace": "games", "task": "SVA-1"},
			bgFault{op: "Get", table: "Backup", match: bgIDIs(made.ID)}},
		{"a webhook's test", "POST", w + "/webhooks/" + hook + "/test", nil,
			bgFault{op: "Get", table: "Webhook", match: bgIDIs(hook)}},
		{"a delivery sent again", "POST", w + "/deliveries/" + id.New() + "/redeliver", nil,
			bgFault{op: "Count", table: "webhook_deliveries"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.storeFault.times = 1
			fired := st.faults.arm(tc.storeFault)
			s.t = t
			s.call(s.owner, "", tc.method, tc.path, tc.body, 500, nil)
			if fired() != 1 {
				t.Fatalf("the fault fired %d times", fired())
			}
		})
	}

	t.Run("a restored item whose reindex fails is still restored, and the failure is logged", func(t *testing.T) {
		st.faults.arm(bgFault{op: "Tasks", table: "tasks", times: 1})
		s.t = t
		s.call(s.owner, "", "POST", "/api/v1/admin/backups/"+made.ID+"/restore-item", M{"workspace": "games", "task": "SVA-1"}, 200, nil)
		if !logs.has("restore from backup: reindexing") {
			t.Fatal("the failed reindex was not logged")
		}
	})
}

func TestAFileOnAPageThatCannotBeReadIsNotShown(t *testing.T) {
	st := newBgFaultStore(t)
	s := newSite(t, st)
	var file struct{ ID string }
	s.call(s.owner, "", "POST", w+"/files?name=notes.txt", []byte("hello"), 201, &file)
	page := s.change(s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "How we work."})["ref"].(string)
	s.change(s.owner, "", "attachment.add", M{"file": file.ID, "doc": page})
	s.change(s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
	s.call(nil, tok.Token, "GET", w+"/files/"+file.ID, nil, 200, nil)

	fired := st.faults.arm(bgFault{op: "Get", table: "Doc", times: 1, match: bgIDIs(page)})
	s.call(nil, tok.Token, "GET", w+"/files/"+file.ID, nil, 404, nil)
	if fired() != 1 {
		t.Fatalf("the fault fired %d times", fired())
	}
}

// bgPullsGitHub stands in for GitHub with one pull request, naming SVA-1,
// and keeps the comments posted on it.
type bgPullsGitHub struct {
	mu       sync.Mutex
	comments []string
	srv      *httptest.Server
}

func newBgPullsGitHub(t *testing.T) *bgPullsGitHub {
	g := &bgPullsGitHub{}
	pull := M{"number": 7, "title": "Fix the jump", "body": "", "state": "open", "draft": false, "html_url": "https://github.example/acme/game/pull/7",
		"updated_at": "2026-11-14T10:00:00Z", "merged_at": nil, "head": M{"ref": "sva-1-jump", "sha": "abc123"}, "user": M{"login": "coder"}}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/pulls"):
			_ = json.NewEncoder(w).Encode([]M{pull})
		case strings.HasSuffix(r.URL.Path, "/check-runs"):
			_ = json.NewEncoder(w).Encode(M{"check_runs": []M{}})
		case strings.HasSuffix(r.URL.Path, "/comments") && r.Method == http.MethodPost:
			var b struct{ Body string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			g.comments = append(g.comments, b.Body)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte("{}"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *bgPullsGitHub) said() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.comments...)
}

func TestAGitHubSyncOutlivesABriefOutage(t *testing.T) {
	st := newBgFaultStore(t)
	s := newSite(t, st)
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Jump feels floaty"})
	gh := newBgPullsGitHub(t)
	in := s.change(s.owner, "", "integration.create", M{"kind": "github", "secret": "ghp_secret",
		"config": M{"repo": "acme/game", "api_url": gh.srv.URL, "comment_back": true}})["ref"].(string)
	integration := func() core.Integration {
		var row core.Integration
		if err := st.Store.Get(context.Background(), &row, store.Eq("id", in)); err != nil {
			t.Fatal(err)
		}
		return row
	}

	t.Run("a comment back waits for a workspace that cannot be read", func(t *testing.T) {
		s.t = t
		st.faults.arm(bgFault{op: "Get", table: "Workspace", times: 1, match: bgIDIs(bgWorkspaceID(t, st.Store))})
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 409, nil)
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)
		said := gh.said()
		if len(said) != 1 || !strings.Contains(said[0], "/games/task/SVA-1") {
			t.Fatalf("comments on the pull request: %q", said)
		}
	})
	t.Run("what a sync did is remembered though the first write fails", func(t *testing.T) {
		s.t = t
		if _, err := st.Store.Update(context.Background(), "integrations", map[string]any{"last_sync_at": 0}, store.Eq("id", in)); err != nil {
			t.Fatal(err)
		}
		fired := st.faults.arm(bgFault{op: "Update", table: "integrations", times: 1, match: bgIDIs(in)})
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)
		if fired() != 1 || integration().LastSyncAt == 0 {
			t.Fatalf("fault fired %d times; the sync was not remembered", fired())
		}
	})
	t.Run("a call from GitHub", func(t *testing.T) {
		s.t = t
		t.Run("for an integration that cannot be read is not answered as unknown", func(t *testing.T) {
			s.t = t
			st.faults.arm(bgFault{op: "Get", table: "Integration", times: 1, match: bgIDIs(in)})
			s.call(nil, "", "POST", "/hooks/github/"+in, []byte("{}"), 500, nil)
		})
		t.Run("too large to read is refused as such", func(t *testing.T) {
			s.t = t
			s.call(nil, "", "POST", "/hooks/github/"+in, bytes.Repeat([]byte("x"), 6<<20), 400, nil)
		})
	})
}

func TestARepositorySyncThatCannotRememberSaysSo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	st := newBgFaultStore(t)
	s := newSite(t, st)
	tmp := t.TempDir()
	origin, work := filepath.Join(tmp, "origin.git"), filepath.Join(tmp, "work")
	gitIn(t, tmp, "init", "--quiet", "--bare", "-b", "main", origin)
	gitIn(t, tmp, "clone", "--quiet", origin, work)
	if err := os.MkdirAll(filepath.Join(work, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "docs", "design.md"), []byte("# Design\n\nThe boss has three phases.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, work, "add", "--all")
	gitIn(t, work, "commit", "--quiet", "-m", "first")
	gitIn(t, work, "push", "--quiet", "origin", "HEAD:main")
	src := s.change(s.owner, "", "source.create", M{"title": "Game docs", "repo": origin, "subdir": "docs"})["ref"].(string)
	s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, nil)
	var pages []core.Doc
	if err := st.Store.List(context.Background(), &pages, store.Where(store.Eq("source_path", "design.md"))); err != nil || len(pages) != 1 {
		t.Fatalf("the page of design.md: %v %v", pages, err)
	}
	s.change(s.owner, "", "doc.write", M{"doc": pages[0].ID, "markdown": "# Design\n\nThe boss has four phases.\n"})

	fired := st.faults.arm(bgFault{op: "Update", table: "docs", times: 1,
		match: func(set map[string]any, _ []store.Cond) bool {
			return set["source_hash"] != nil && set["source_hash"] != ""
		}})
	s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 409, nil)
	if fired() != 1 {
		t.Fatalf("the fault fired %d times", fired())
	}
}

func TestAToolCallWhoseParamsDoNotReadIsToldSo(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
	var answer struct {
		Error struct {
			Code    int
			Message string
		}
	}
	s.call(nil, tok.Token, "POST", "/mcp", []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":["whoami"]}`), 200, &answer)
	if answer.Error.Code != -32602 || !strings.Contains(answer.Error.Message, "the params do not read") {
		t.Fatalf("the answer's error: %+v", answer.Error)
	}
}
