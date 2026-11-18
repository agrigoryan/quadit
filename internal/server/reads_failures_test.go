package server_test

import (
	"bytes"
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// readsAs is the site as one sub-test sees it: a failed call fails that
// sub-test.
func readsAs(s *site, t *testing.T) *site {
	sub := *s
	sub.t = t
	return &sub
}

// A read that fails is a server error, not "there is no such thing": an
// outage must not tell an agent that a page is gone, that its cursor stands
// at the start, or make it read the whole feed again.
func TestReadsAnswerAFailedReadAsAnErrorNotAsNotFound(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		page := s.change(s.owner, "", "doc.create", M{"title": "Boss fight", "markdown": "Three phases."})["ref"].(string)
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion effect"})
		s.call(s.owner, "", "PUT", w+"/cursors/main", M{"seq": 3}, 200, nil)

		t.Run("a page", func(t *testing.T) {
			s := readsAs(s, t)
			fs.faults.set("get docs")
			s.call(s.owner, "", "GET", w+"/docs/"+page, nil, 500, nil)
			fs.faults.clear()
			s.call(s.owner, "", "GET", w+"/docs/"+page, nil, 200, nil)
		})
		t.Run("a cursor", func(t *testing.T) {
			s := readsAs(s, t)
			fs.faults.set("get cursors")
			s.call(s.owner, "", "GET", w+"/cursors/main", nil, 500, nil)
			fs.faults.clear()
			if out := s.call(s.owner, "", "GET", w+"/cursors/main", nil, 200, nil); !strings.Contains(out, `"seq":3`) {
				t.Fatalf("cursor = %s", out)
			}
		})
		t.Run("the feed read from a cursor", func(t *testing.T) {
			s := readsAs(s, t)
			fs.faults.set("get cursors")
			s.call(s.owner, "", "GET", w+"/events?cursor=main", nil, 500, nil)
			fs.faults.clear()
		})
	})
}

// A part of an answer that cannot be read fails the answer, instead of
// being given as 0 or as nothing there.
func TestReadsDoNotGiveAFailedCountAsZero(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
		var tok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &tok)

		t.Run("the dashboard's failing webhooks", func(t *testing.T) {
			s := readsAs(s, t)
			fs.faults.set("count webhooks")
			s.call(s.owner, "", "GET", w+"/dashboard", nil, 500, nil)
			fs.faults.clear()
		})
		t.Run("the closed tasks a starting copy leaves for later", func(t *testing.T) {
			s := readsAs(s, t)
			fs.faults.set("count tasks")
			s.call(s.owner, "", "GET", w+"/bootstrap?part=open", nil, 500, nil)
			fs.faults.clear()
		})
		t.Run("an agent's memory root", func(t *testing.T) {
			// Not found, the root would be made a second time.
			s := readsAs(s, t)
			s.call(nil, tok.Token, "POST", "/api/v1/w/-/memory", M{"title": "Setup", "markdown": "one"}, 201, nil)
			fs.faults.set("list docs")
			s.call(nil, tok.Token, "POST", "/api/v1/w/-/memory", M{"title": "Later", "markdown": "two"}, 500, nil)
			fs.faults.clear()
			var docs struct{ Docs []M }
			s.call(s.owner, "", "GET", w+"/docs", nil, 200, &docs)
			roots := 0
			for _, doc := range docs.Docs {
				if doc["memory_of"] != nil && doc["parent_id"] == nil {
					roots++
				}
			}
			if roots != 1 {
				t.Fatalf("%d memory roots: %v", roots, docs.Docs)
			}
		})
	})
}

// The context pack reports a parent it could not read as an error, instead
// of failing on the missing answer.
func TestContextPackReportsAFailedParentRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := &readsTasksByIDFault{Store: st}
		s, logs := readsSiteWithLog(t, fs)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		top := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss"})["ref"].(string)
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss art", "parent": top})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss idle frames", "parent": "SVA-2"})

		// The pack names the parent's own parent by key: that read fails.
		// Other reads of tasks come before it, so the shared faulty store,
		// which fails every read of a table, cannot single it out.
		fs.failNext(top)
		s.call(s.owner, "", "GET", w+"/tasks/SVA-3/context", nil, 500, nil)
		log := logs.String()
		if strings.Contains(log, "panic") || !strings.Contains(log, errOutage.Error()) {
			t.Fatalf("the failed read is not what was reported:\n%s", log)
		}
		if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-3/context?format=text", nil, 200, nil); !strings.Contains(out, "Boss art") {
			t.Fatalf("context pack = %s", out)
		}
	})
}

// readsTasksByIDFault is a store whose next read of exactly some tasks by
// id fails.
type readsTasksByIDFault struct {
	store.Store
	mu  sync.Mutex
	ids []string
}

func (f *readsTasksByIDFault) failNext(ids ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ids = ids
}

func (f *readsTasksByIDFault) In(workspaceID string) store.DB {
	return &readsTasksByIDDB{DB: f.Store.In(workspaceID), fault: f}
}

type readsTasksByIDDB struct {
	store.DB
	fault *readsTasksByIDFault
}

func (d *readsTasksByIDDB) Tasks(ctx context.Context, filter store.TaskFilter) ([]core.Task, error) {
	f := d.fault
	f.mu.Lock()
	fail := f.ids != nil && slices.Equal(f.ids, filter.IDs)
	if fail {
		f.ids = nil
	}
	f.mu.Unlock()
	if fail {
		return nil, errOutage
	}
	return d.DB.Tasks(ctx, filter)
}

// readsLog is a log the server and the test share.
type readsLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *readsLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *readsLog) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// readsSiteWithLog is newSite with the server's log kept for the test to read.
func readsSiteWithLog(t *testing.T, st store.Store) (*site, *readsLog) {
	t.Helper()
	logs := &readsLog{}
	dir := t.TempDir()
	files, err := blob.NewDisk(dir + "/files")
	if err != nil {
		t.Fatal(err)
	}
	sealer, err := auth.NewSealer([]byte("a test secret, long enough"))
	if err != nil {
		t.Fatal(err)
	}
	hs, base := localhostServer(t)
	srv := server.New(server.Config{DataDir: dir, BaseURL: base, Version: "test", Log: slog.New(slog.NewTextHandler(logs, nil))}, st, files, sealer)
	hs.Config.Handler = srv.Handler()
	hs.Start()
	ctx, stop := context.WithCancel(context.Background())
	go srv.Run(ctx)
	t.Cleanup(func() { stop(); hs.Close() })
	s := &site{t: t, url: base, dir: dir, owner: browser(), srv: srv}
	s.call(s.owner, "", "POST", "/api/v1/auth/setup", map[string]any{"name": "Aram", "email": "owner@example.com",
		"password": "correct-horse-battery", "workspace_name": "Games"}, 201, nil)
	return s, logs
}
