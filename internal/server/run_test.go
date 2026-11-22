package server_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAFileStoreThatCannotBeReachedIsNotReplacedByTheDisk: a server set to
// keep files in a cloud store it cannot reach at start is not ready, and
// stores nothing on its local disk instead; it says so, it does not quietly
// carry on with the wrong store.
func TestAFileStoreThatCannotBeReachedIsNotReplacedByTheDisk(t *testing.T) {
	// Not in parallel: the file store is set through the process's environment (t.Setenv).
	testdb.Each(t, func(t *testing.T, st store.Store) {
		t.Setenv("QUADIT_SETTING_FILES", `{"kind":"s3","bucket":"quadit","endpoint":"http://127.0.0.1:1","access_key":"a","secret_key":"b","region":"us-east-1"}`)
		s := newSite(t, st)

		var status int
		var said string
		for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			resp, err := http.Get(s.url + "/readyz")
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			status, said = resp.StatusCode, string(raw)
			if status != http.StatusOK {
				break
			}
		}
		if status != http.StatusServiceUnavailable || !strings.Contains(said, "file") {
			t.Fatalf("/readyz with the file store away: %d %q, want 503 naming the file store", status, said)
		}

		resp, err := s.owner.Post(s.url+w+"/files?name=notes.txt", "text/plain", strings.NewReader("hello"))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 300 {
			t.Errorf("an upload with the file store away was taken: %d %s", resp.StatusCode, raw)
		}
		var kept []string
		_ = filepath.WalkDir(filepath.Join(s.dir, "files"), func(path string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				kept = append(kept, path)
			}
			return nil
		})
		if len(kept) > 0 {
			t.Fatalf("an upload with the file store away went to the local disk: %v", kept)
		}
	})
}

// TestNoFileIsTakenWhileTheStoreThatIsSetIsBeingOpened: while the cloud
// store a server is set to keep files in is still being opened (here a
// store that takes the connection and never answers), the server is not
// ready, and an upload is answered "try again later" and goes nowhere:
// not to the local disk in its place.
func TestNoFileIsTakenWhileTheStoreThatIsSetIsBeingOpened(t *testing.T) {
	// Not in parallel: the file store is set through the process's environment (t.Setenv).
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var held sync.WaitGroup
	t.Cleanup(func() { silent.Close(); held.Wait() })
	held.Go(func() {
		var conns []net.Conn
		defer func() {
			for _, c := range conns {
				c.Close()
			}
		}()
		for {
			c, err := silent.Accept()
			if err != nil {
				return
			}
			conns = append(conns, c)
		}
	})
	testdb.Each(t, func(t *testing.T, st store.Store) {
		t.Setenv("QUADIT_SETTING_FILES", `{"kind":"s3","bucket":"quadit","endpoint":"http://`+silent.Addr().String()+`","access_key":"a","secret_key":"b","region":"us-east-1"}`)
		s := newSite(t, st)

		resp, err := http.Get(s.url + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("/readyz while the file store is being opened: %d, want 503", resp.StatusCode)
		}
		out := s.call(t, s.owner, "", "POST", w+"/files?name=notes.txt", []byte("hello"), http.StatusServiceUnavailable, nil)
		if !strings.Contains(out, "file") {
			t.Errorf("the refused upload does not say why: %s", out)
		}
		var kept []string
		_ = filepath.WalkDir(filepath.Join(s.dir, "files"), func(path string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				kept = append(kept, path)
			}
			return nil
		})
		if len(kept) > 0 {
			t.Fatalf("an upload while the file store was being opened went to the local disk: %v", kept)
		}
	})
}

// TestFileStorageWaitsForItsSettingToBeRead: a server that cannot read the
// "files" setting when it starts does not know which store holds the
// files, so it stores and reads none (it is not ready, and an upload is
// answered "try again later") rather than taking the local disk for it.
// Once the setting can be read, the store it names is used.
func TestFileStorageWaitsForItsSettingToBeRead(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		if err := st.Upsert(context.Background(), &core.Setting{Name: "files", Value: json.RawMessage(`{"kind":"disk"}`)}, "name"); err != nil {
			t.Fatal(err)
		}
		fs := newFaultyStore(st)
		fs.faults.arm(fault{op: "get", table: "settings", match: func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "name", "files") }})
		s := newSite(t, fs)
		ready := func() (int, string) {
			resp, err := http.Get(s.url + "/readyz")
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			return resp.StatusCode, string(raw)
		}

		if status, said := ready(); status != http.StatusServiceUnavailable || !strings.Contains(said, "file") {
			t.Fatalf("/readyz with the files setting unreadable: %d %q, want 503 naming the file store", status, said)
		}
		req, _ := http.NewRequest(http.MethodPost, s.url+w+"/files?name=notes.txt", strings.NewReader("hello"))
		resp, err := s.owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Retry-After") == "" {
			t.Fatalf("an upload with the files setting unreadable: %d, Retry-After %q; want 503 with Retry-After", resp.StatusCode, resp.Header.Get("Retry-After"))
		}
		var kept []string
		_ = filepath.WalkDir(filepath.Join(s.dir, "files"), func(path string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				kept = append(kept, path)
			}
			return nil
		})
		if len(kept) > 0 {
			t.Fatalf("an upload with the files setting unreadable went to the local disk: %v", kept)
		}

		fs.faults.clear()
		for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(100 * time.Millisecond) {
			status, said := ready()
			if status == http.StatusOK {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("/readyz once the files setting reads again: %d %q, want 200", status, said)
			}
		}
		s.call(t, s.owner, "", "POST", w+"/files?name=notes.txt", []byte("hello"), 201, nil)
	})
}

// TestFileStorageStopsWhenRunCannotReadItsSetting: a server that read the
// "files" setting when it was made (the disk) but cannot read it again
// when its background work starts, after that read is no longer kept,
// does not go on with the disk: another server may have set a cloud store
// meanwhile. It stores and reads no file until the setting can be read.
func TestFileStorageStopsWhenRunCannotReadItsSetting(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		dir := t.TempDir()
		disk, err := blob.NewDisk(dir + "/files")
		if err != nil {
			t.Fatal(err)
		}
		sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
		hs, base := localhostServer(t)
		ctx, stop := context.WithCancel(context.Background())
		srv := server.New(ctx, server.Config{DataDir: dir, BaseURL: base, Version: "test"}, fs, disk, sealer)
		hs.Config.Handler = srv.Handler()
		hs.Start()
		ran := make(chan struct{})
		t.Cleanup(func() { stop(); <-ran; hs.Close() })
		ready := func() int {
			resp, err := http.Get(base + "/readyz")
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}

		time.Sleep(3500 * time.Millisecond) // past the three seconds a setting read is kept
		fs.faults.arm(fault{op: "get", table: "settings", match: func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "name", "files") }})
		go func() {
			defer close(ran)
			srv.Run(ctx)
		}()
		for deadline := time.Now().Add(5 * time.Second); ready() != http.StatusServiceUnavailable; time.Sleep(50 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("/readyz is still ready on the disk with the files setting unreadable")
			}
		}
		fs.faults.clear()
		for deadline := time.Now().Add(20 * time.Second); ready() != http.StatusOK; time.Sleep(100 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("/readyz once the files setting reads again is not ready")
			}
		}
	})
}
