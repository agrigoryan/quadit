package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// failingFiles is file storage that refuses to store a whole file (any key
// that is not one part of an upload) while failing is set.
type failingFiles struct {
	blob.Store
	failing atomic.Bool
}

func (f *failingFiles) Put(ctx context.Context, key string, r io.Reader, ct string) error {
	if f.failing.Load() && !strings.Contains(key, ".parts/") {
		return errors.New("the storage is down")
	}
	return f.Store.Put(ctx, key, r, ct)
}

// keys lists what file storage holds under a prefix.
func (f *failingFiles) keys(t *testing.T, prefix string) []string {
	t.Helper()
	var out []string
	if err := f.List(context.Background(), prefix, func(k string, _ int64) error { out = append(out, k); return nil }); err != nil {
		t.Fatal(err)
	}
	return out
}

// uploaded is a file as the upload answers give it.
type uploaded struct {
	ID, State, SHA256 string
	Received          int64
}

// sumOf is the checksum an upload of data must end with.
func sumOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// TestAnUploadWhoseStoringFailsCanBeFinishedLater: when the whole file
// cannot be stored at the end of an upload, nothing that arrived is
// thrown away; asking again once storage is back finishes it, with the
// bytes that were sent.
func TestAnUploadWhoseStoringFailsCanBeFinishedLater(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		files := &failingFiles{Store: disk}
		s := newSiteWithFiles(t, st, files)
		data := []byte(strings.Repeat("0123456789", 600))

		t.Run("in parts", func(t *testing.T) {
			var f uploaded
			s.call(s.owner, "", "POST", fmt.Sprintf(w+"/files?name=clip.bin&size=%d", len(data)), data[:2000], 201, &f)
			files.failing.Store(true)
			s.call(s.owner, "", "PATCH", w+"/files/"+f.ID+"?offset=2000", data[2000:], 500, nil)
			files.failing.Store(false)
			s.call(s.owner, "", "GET", w+"/files/"+f.ID, nil, 200, &f)
			if f.State != "uploading" || f.Received != int64(len(data)) {
				t.Fatalf("after storing failed the file is %+v", f)
			}
			s.call(s.owner, "", "PATCH", fmt.Sprintf(w+"/files/%s?offset=%d", f.ID, len(data)), nil, 200, &f)
			if f.State != "ready" || f.SHA256 != sumOf(data) {
				t.Fatalf("finished again, the file is %+v, want the sum %s", f, sumOf(data))
			}
			if left := files.keys(t, ""); strings.Contains(strings.Join(left, " "), ".parts/") {
				t.Fatalf("parts left behind once the file is stored: %v", left)
			}
		})

		t.Run("in one request", func(t *testing.T) {
			fid := id.New()
			files.failing.Store(true)
			path := fmt.Sprintf(w+"/files?name=notes.txt&size=%d&id=%s", len(data), fid)
			s.call(s.owner, "", "POST", path, data, 500, nil)
			files.failing.Store(false)
			var f uploaded
			s.call(s.owner, "", "POST", path, data, 200, &f)
			if f.State != "ready" || f.SHA256 != sumOf(data) {
				t.Fatalf("finished again, the file is %+v, want the sum %s", f, sumOf(data))
			}
		})
	})
}

// meetingFiles is file storage where parts of an upload after the first
// wait for each other: a part is stored once `together` of them have come
// (or a moment has passed), so they are all under way at once.
type meetingFiles struct {
	blob.Store
	together int32
	arrived  atomic.Int32
	all      chan struct{}
}

func (f *meetingFiles) Put(ctx context.Context, key string, r io.Reader, ct string) error {
	if strings.Contains(key, ".parts/") && !strings.Contains(key, ".parts/00000000000000000000") {
		if f.arrived.Add(1) == f.together {
			close(f.all)
		}
		select {
		case <-f.all:
		case <-time.After(5 * time.Second):
		}
	}
	return f.Store.Put(ctx, key, r, ct)
}

// TestPartsOfOneUploadSentAtOnceTakeTurns: parts sent at the same time
// for the same place are taken one at a time. One is kept, the others are
// told where to continue from, and the file ends as the bytes that were
// kept, every one counted once.
func TestPartsOfOneUploadSentAtOnceTakeTurns(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		s := newSiteWithFiles(t, st, &meetingFiles{Store: disk, together: 8, all: make(chan struct{})})
		data := []byte(strings.Repeat("abcdefghij", 300))
		var f uploaded
		s.call(s.owner, "", "POST", fmt.Sprintf(w+"/files?name=clip.bin&size=%d", len(data)), data[:1000], 201, &f)
		// Some send the next thousand bytes, some the next fifteen hundred;
		// none of them the last.
		var wg sync.WaitGroup
		var kept, refused atomic.Int32
		for i := range 8 {
			wg.Go(func() {
				body := data[1000:2000]
				if i%2 == 1 {
					body = data[1000:2500]
				}
				req, _ := http.NewRequest(http.MethodPatch, s.url+w+"/files/"+f.ID+"?offset=1000", strings.NewReader(string(body)))
				resp, err := s.owner.Do(req)
				if err != nil {
					t.Error(err)
					return
				}
				resp.Body.Close()
				switch resp.StatusCode {
				case http.StatusOK:
					kept.Add(1)
				case http.StatusConflict:
					refused.Add(1)
				default:
					t.Errorf("a part sent at once with others: %d", resp.StatusCode)
				}
			})
		}
		wg.Wait()
		if kept.Load() != 1 || refused.Load() != 7 {
			t.Fatalf("%d parts kept and %d refused, want 1 and 7", kept.Load(), refused.Load())
		}
		s.call(s.owner, "", "GET", w+"/files/"+f.ID, nil, 200, &f)
		if f.Received != 2000 && f.Received != 2500 {
			t.Fatalf("received %d, which is no part's end", f.Received)
		}
		s.call(s.owner, "", "PATCH", fmt.Sprintf(w+"/files/%s?offset=%d", f.ID, f.Received), data[f.Received:], 200, &f)
		if f.State != "ready" || f.SHA256 != sumOf(data) {
			t.Fatalf("the file ended as %+v, want the sum %s", f, sumOf(data))
		}
	})
}

// TestFirstRequestsUnderOneIDDoNotShareWhatTheyReceive: two first requests
// under the same id, one still arriving when the other comes, do not write
// into, or clean up, what the other received. The first to come is the
// upload; the other is told how far it has got. When storing the file then
// fails, asking again finishes it from what the first request brought.
func TestFirstRequestsUnderOneIDDoNotShareWhatTheyReceive(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		files := &failingFiles{Store: disk}
		s := newSiteWithFiles(t, st, files)
		data := []byte(strings.Repeat("0123456789", 1000))
		fid := id.New()
		path := fmt.Sprintf(w+"/files?name=notes.txt&size=%d&id=%s", len(data), fid)
		files.failing.Store(true)

		// The slow one: half its bytes, then a pause while the other comes.
		body, send := io.Pipe()
		t.Cleanup(func() { send.Close() }) // a test that fails half way leaves no request hanging
		slow := make(chan int, 1)
		go func() {
			req, _ := http.NewRequest(http.MethodPost, s.url+path, body)
			req.Header.Set("Content-Type", "text/plain") // a body with no type is read whole before it is sent
			resp, err := s.owner.Do(req)
			if err != nil {
				t.Error(err)
				slow <- 0
				return
			}
			resp.Body.Close()
			slow <- resp.StatusCode
		}()
		if _, err := send.Write(data[:len(data)/2]); err != nil {
			t.Fatal(err)
		}
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
			resp, err := s.owner.Get(s.url + w + "/files/" + fid)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("the first request is not there: %d", resp.StatusCode)
			}
		}
		var other uploaded
		s.call(s.owner, "", "POST", path, data, 200, &other)
		if other.State != "uploading" || other.Received != 0 {
			t.Fatalf("the second first request, while the first is arriving: %+v", other)
		}
		if _, err := send.Write(data[len(data)/2:]); err != nil {
			t.Fatal(err)
		}
		send.Close()
		if code := <-slow; code != http.StatusInternalServerError {
			t.Fatalf("the first request, with storage down: %d", code)
		}

		files.failing.Store(false)
		var f uploaded
		s.call(s.owner, "", "POST", path, data, 200, &f)
		if f.State != "ready" || f.SHA256 != sumOf(data) {
			t.Fatalf("finished again, the file is %+v, want the sum %s", f, sumOf(data))
		}
		if left, _ := os.ReadDir(filepath.Join(s.dir, "uploads")); len(left) > 0 {
			t.Fatalf("left on this machine once the file is stored: %v", left)
		}
	})
}
