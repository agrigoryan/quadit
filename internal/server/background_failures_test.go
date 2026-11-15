package server_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
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

// errOutage is what a faulty store answers with: a database that is
// briefly unreachable, not a row that is missing.
var errOutage = errors.New("the database is briefly unreachable")

// fault makes the next calls of one store method on one table fail.
type fault struct {
	op    string // Get, List, Count, Update, Delete, Events, Insert
	table string // the table name, or for Get, List and Insert the row's type name (Webhook)
	// match narrows the calls that fail; nil fails them all.
	match func(set map[string]any, where []store.Cond) bool
	times int // how many calls fail; then the fault is spent

	hits int
}

// faults is the set of armed faults a faultStore checks every call against.
type faults struct {
	mu   sync.Mutex
	list []*fault
}

func (fs *faults) check(op, table string, set map[string]any, where []store.Cond) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for _, f := range fs.list {
		if f.op == op && f.table == table && f.hits < f.times && (f.match == nil || f.match(set, where)) {
			f.hits++
			return errOutage
		}
	}
	return nil
}

// arm adds a fault and returns a function that says how often it fired.
func (fs *faults) arm(f fault) func() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.list = append(fs.list, &f)
	return func() int {
		fs.mu.Lock()
		defer fs.mu.Unlock()
		return f.hits
	}
}

// faultStore is a store whose reads and writes can be made to fail, through
// the store itself and through the workspace-bound DBs it hands out.
type faultStore struct {
	store.Store
	faults *faults
}

func newFaultStore(t *testing.T) faultStore {
	return faultStore{Store: testdb.SQLite(t), faults: &faults{}}
}

// typeName is the name of the row type behind a pointer to a row or a slice.
func typeName(dst any) string {
	t := reflect.TypeOf(dst)
	for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice {
		t = t.Elem()
	}
	return t.Name()
}

// whereHas reports whether the conditions say col = val.
func whereHas(where []store.Cond, col string, val any) bool {
	for _, c := range where {
		if c.Col == col && c.Op == "=" && c.Val == val {
			return true
		}
	}
	return false
}

func (s faultStore) In(workspaceID string) store.DB {
	return faultDB{DB: s.Store.In(workspaceID), faults: s.faults}
}

func (s faultStore) Get(ctx context.Context, dst any, where ...store.Cond) error {
	return faultDB{DB: s.Store, faults: s.faults}.Get(ctx, dst, where...)
}

func (s faultStore) List(ctx context.Context, dst any, q store.Q) error {
	return faultDB{DB: s.Store, faults: s.faults}.List(ctx, dst, q)
}

func (s faultStore) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	return faultDB{DB: s.Store, faults: s.faults}.Count(ctx, table, where...)
}

func (s faultStore) Insert(ctx context.Context, row any) error {
	return faultDB{DB: s.Store, faults: s.faults}.Insert(ctx, row)
}

func (s faultStore) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	return faultDB{DB: s.Store, faults: s.faults}.Update(ctx, table, set, where...)
}

func (s faultStore) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	return faultDB{DB: s.Store, faults: s.faults}.Delete(ctx, table, where...)
}

// faultDB is a store.DB that fails the calls its faults name.
type faultDB struct {
	store.DB
	faults *faults
}

func (d faultDB) Get(ctx context.Context, dst any, where ...store.Cond) error {
	if err := d.faults.check("Get", typeName(dst), nil, where); err != nil {
		return err
	}
	return d.DB.Get(ctx, dst, where...)
}

func (d faultDB) List(ctx context.Context, dst any, q store.Q) error {
	if err := d.faults.check("List", typeName(dst), nil, q.Where); err != nil {
		return err
	}
	return d.DB.List(ctx, dst, q)
}

func (d faultDB) Count(ctx context.Context, table string, where ...store.Cond) (int, error) {
	if err := d.faults.check("Count", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Count(ctx, table, where...)
}

func (d faultDB) Insert(ctx context.Context, row any) error {
	if err := d.faults.check("Insert", typeName(row), nil, nil); err != nil {
		return err
	}
	return d.DB.Insert(ctx, row)
}

func (d faultDB) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	if err := d.faults.check("Update", table, set, where); err != nil {
		return 0, err
	}
	return d.DB.Update(ctx, table, set, where...)
}

func (d faultDB) Delete(ctx context.Context, table string, where ...store.Cond) (int64, error) {
	if err := d.faults.check("Delete", table, nil, where); err != nil {
		return 0, err
	}
	return d.DB.Delete(ctx, table, where...)
}

func (d faultDB) Tasks(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	if err := d.faults.check("Tasks", "tasks", nil, nil); err != nil {
		return nil, err
	}
	return d.DB.Tasks(ctx, f)
}

func (d faultDB) Events(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	if err := d.faults.check("Events", "events", nil, nil); err != nil {
		return nil, err
	}
	return d.DB.Events(ctx, f)
}

// logBuffer collects what servers made after it is set up log, for a test
// to wait for a line.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logBuffer) has(text string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Contains(l.buf.String(), text)
}

// captureLogs sends the default logger, which a server made without its
// own logs to, into a buffer until the test ends.
func captureLogs(t *testing.T) *logBuffer {
	t.Helper()
	logs := &logBuffer{}
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })
	return logs
}

// workspaceID is the id of the site's one workspace.
func workspaceID(t *testing.T, st store.Store) string {
	t.Helper()
	var wss []core.Workspace
	if err := st.List(context.Background(), &wss, store.Q{}); err != nil || len(wss) != 1 {
		t.Fatalf("workspaces: %v %v", wss, err)
	}
	return wss[0].ID
}

// deliveryOf is the one delivery made to a webhook.
func deliveryOf(t *testing.T, st store.Store, hookID string) core.WebhookDelivery {
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
		logs := captureLogs(t)
		st := newFaultStore(t)
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		rcv := newReceiver(t, "")
		hook := s.change(s.owner, "", "webhook.create", M{"name": "tasks", "url": rcv.srv.URL, "event_types": []string{"task.*"}})["ref"].(string)
		fired := st.faults.arm(fault{op: "Get", table: "Webhook", times: 1,
			match: func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "id", hook) }})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Dock crane"})
		eventually(t, "the delivery to fail on its webhook, and to be given up or kept", func() bool {
			return fired() == 1 && (deliveryOf(t, st.Store, hook).State == "dead" || logs.has("webhook delivery: reading its webhook"))
		})
		if d := deliveryOf(t, st.Store, hook); d.State != "pending" {
			t.Fatalf("after a failed read the delivery is %q (%s), want it pending for another try", d.State, d.Error)
		}
	})
	t.Run("a sent delivery is recorded though the first write fails", func(t *testing.T) {
		st := newFaultStore(t)
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		rcv := newReceiver(t, "")
		hook := s.change(s.owner, "", "webhook.create", M{"name": "tasks", "url": rcv.srv.URL, "event_types": []string{"task.*"}})["ref"].(string)
		fired := st.faults.arm(fault{op: "Update", table: "webhook_deliveries", times: 1,
			match: func(set map[string]any, _ []store.Cond) bool { return set["state"] == "ok" }})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Dock crane"})
		eventually(t, "the delivery to be recorded as done", func() bool { return deliveryOf(t, st.Store, hook).State == "ok" })
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
		st := newFaultStore(t)
		newSite(t, st)
		job := id.New()
		fired := st.faults.arm(fault{op: "Update", table: "jobs", times: 1,
			match: func(set map[string]any, where []store.Cond) bool {
				_, done := set["done_at"]
				return done && whereHas(where, "id", job)
			}})
		queueJob(t, st.Store, job, workspaceID(t, st.Store), "an item that is gone")
		eventually(t, "the job to be recorded as done", func() bool { return jobOf(t, st.Store, job).DoneAt != 0 })
		if fired() != 1 {
			t.Fatalf("fault fired %d times", fired())
		}
	})
	t.Run("an inbox item that cannot be read for a moment is tried again", func(t *testing.T) {
		st := newFaultStore(t)
		newSite(t, st)
		item := id.New()
		st.faults.arm(fault{op: "Get", table: "Notification", times: 1,
			match: func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "id", item) }})
		job := id.New()
		queueJob(t, st.Store, job, workspaceID(t, st.Store), item)
		eventually(t, "the job to run once", func() bool { j := jobOf(t, st.Store, job); return j.DoneAt != 0 || j.Error != "" })
		if j := jobOf(t, st.Store, job); j.DoneAt != 0 || !strings.Contains(j.Error, errOutage.Error()) {
			t.Fatalf("after a failed read the job is done at %d with error %q; want it waiting to be tried again", j.DoneAt, j.Error)
		}
		eventually(t, "the job to be done on its second try", func() bool { return jobOf(t, st.Store, job).DoneAt != 0 })
	})
}

// idIs matches the calls about one row.
func idIs(rowID string) func(map[string]any, []store.Cond) bool {
	return func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "id", rowID) }
}

func TestAReadThatFailsIsNotAnsweredAsNotFound(t *testing.T) {
	logs := captureLogs(t)
	st := newFaultStore(t)
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
		fault        fault
	}{
		{"the next part of an upload", "PATCH", w + "/files/" + started.ID + "?offset=4", []byte("567890"),
			fault{op: "Get", table: "File", match: idIs(started.ID)}},
		{"an upload started again with its own id", "POST", w + "/files?name=again.txt&id=" + repeat, []byte("x"),
			fault{op: "Get", table: "File", match: idIs(repeat)}},
		{"an import of an uploaded file", "POST", w + "/import", M{"kind": "markdown", "file": ready.ID},
			fault{op: "Get", table: "File", match: idIs(ready.ID)}},
		{"a backup's download", "GET", "/api/v1/admin/backups/" + made.ID + "/download", nil,
			fault{op: "Get", table: "Backup", match: idIs(made.ID)}},
		{"a restore from a backup", "POST", "/api/v1/admin/backups/" + made.ID + "/restore-item", M{"workspace": "games", "task": "SVA-1"},
			fault{op: "Get", table: "Backup", match: idIs(made.ID)}},
		{"a webhook's test", "POST", w + "/webhooks/" + hook + "/test", nil,
			fault{op: "Get", table: "Webhook", match: idIs(hook)}},
		{"a delivery sent again", "POST", w + "/deliveries/" + id.New() + "/redeliver", nil,
			fault{op: "Count", table: "webhook_deliveries"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.fault.times = 1
			fired := st.faults.arm(tc.fault)
			s.t = t
			s.call(s.owner, "", tc.method, tc.path, tc.body, 500, nil)
			if fired() != 1 {
				t.Fatalf("the fault fired %d times", fired())
			}
		})
	}

	t.Run("a restored item whose reindex fails is still restored, and the failure is logged", func(t *testing.T) {
		st.faults.arm(fault{op: "Tasks", table: "tasks", times: 1})
		s.t = t
		s.call(s.owner, "", "POST", "/api/v1/admin/backups/"+made.ID+"/restore-item", M{"workspace": "games", "task": "SVA-1"}, 200, nil)
		if !logs.has("restore from backup: reindexing") {
			t.Fatal("the failed reindex was not logged")
		}
	})
}

func TestAFileOnAPageThatCannotBeReadIsNotShown(t *testing.T) {
	st := newFaultStore(t)
	s := newSite(t, st)
	var file struct{ ID string }
	s.call(s.owner, "", "POST", w+"/files?name=notes.txt", []byte("hello"), 201, &file)
	page := s.change(s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "How we work."})["ref"].(string)
	s.change(s.owner, "", "attachment.add", M{"file": file.ID, "doc": page})
	s.change(s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
	s.call(nil, tok.Token, "GET", w+"/files/"+file.ID, nil, 200, nil)

	fired := st.faults.arm(fault{op: "Get", table: "Doc", times: 1, match: idIs(page)})
	s.call(nil, tok.Token, "GET", w+"/files/"+file.ID, nil, 404, nil)
	if fired() != 1 {
		t.Fatalf("the fault fired %d times", fired())
	}
}
