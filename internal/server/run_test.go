package server_test

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAFileStoreThatCannotBeReachedIsNotReplacedByTheDisk: a server set to
// keep files in a cloud store it cannot reach at start is not ready, and
// stores nothing on its local disk instead; it says so, it does not quietly
// carry on with the wrong store.
func TestAFileStoreThatCannotBeReachedIsNotReplacedByTheDisk(t *testing.T) {
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
		out := s.call(s.owner, "", "POST", w+"/files?name=notes.txt", []byte("hello"), http.StatusServiceUnavailable, nil)
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
