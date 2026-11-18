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
	"github.com/agrigoryan/quadit/internal/core"
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
			s.call(t, s.owner, "", "POST", fmt.Sprintf(w+"/files?name=clip.bin&size=%d", len(data)), data[:2000], 201, &f)
			files.failing.Store(true)
			s.call(t, s.owner, "", "PATCH", w+"/files/"+f.ID+"?offset=2000", data[2000:], 500, nil)
			files.failing.Store(false)
			s.call(t, s.owner, "", "GET", w+"/files/"+f.ID, nil, 200, &f)
			if f.State != "uploading" || f.Received != int64(len(data)) {
				t.Fatalf("after storing failed the file is %+v", f)
			}
			s.call(t, s.owner, "", "PATCH", fmt.Sprintf(w+"/files/%s?offset=%d", f.ID, len(data)), nil, 200, &f)
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
			s.call(t, s.owner, "", "POST", path, data, 500, nil)
			files.failing.Store(false)
			var f uploaded
			s.call(t, s.owner, "", "POST", path, data, 200, &f)
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
		s.call(t, s.owner, "", "POST", fmt.Sprintf(w+"/files?name=clip.bin&size=%d", len(data)), data[:1000], 201, &f)
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
		s.call(t, s.owner, "", "GET", w+"/files/"+f.ID, nil, 200, &f)
		if f.Received != 2000 && f.Received != 2500 {
			t.Fatalf("received %d, which is no part's end", f.Received)
		}
		s.call(t, s.owner, "", "PATCH", fmt.Sprintf(w+"/files/%s?offset=%d", f.ID, f.Received), data[f.Received:], 200, &f)
		if f.State != "ready" || f.SHA256 != sumOf(data) {
			t.Fatalf("the file ended as %+v, want the sum %s", f, sumOf(data))
		}
	})
}

// legacyUpload writes an upload in parts as a server before schema version
// 14 left it: each part in file storage under a key made from its offset
// alone, the parts listed nowhere (the column for them came later and is
// NULL), and what arrived counted on the row. It gives the file's id.
func legacyUpload(t *testing.T, s *site, st store.Store, files blob.Store, size, received int64, parts map[int64]string) string {
	t.Helper()
	ctx := context.Background()
	var ws core.Workspace
	if err := st.Get(ctx, &ws, store.Eq("slug", "games")); err != nil {
		t.Fatal(err)
	}
	f := core.File{ID: id.New(), WorkspaceID: ws.ID, Name: "clip.bin", ContentType: "application/octet-stream", Size: size, Received: received,
		State: core.FileUploading, UploadedBy: s.ownerID(t), CreatedAt: time.Now().UnixMilli()}
	f.StorageKey = ws.ID + "/" + f.ID
	for offset, data := range parts {
		if err := files.Put(ctx, fmt.Sprintf("%s.parts/%020d", f.StorageKey, offset), strings.NewReader(data), "application/octet-stream"); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.In(ws.ID).Insert(ctx, f); err != nil {
		t.Fatal(err)
	}
	return f.ID
}

// TestAnUploadFromBeforeTheUpgradeGoesOn: an upload in parts that a server
// before version 14 had started goes on after the upgrade from what that
// server kept, and ends as every byte that was sent: none dropped, none
// counted that is not there.
func TestAnUploadFromBeforeTheUpgradeGoesOn(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		files := &failingFiles{Store: disk}
		s := newSiteWithFiles(t, st, files)
		finish := func(t *testing.T, fid string, from int64, rest, whole string) {
			t.Helper()
			var f uploaded
			s.call(t, s.owner, "", "PATCH", fmt.Sprintf(w+"/files/%s?offset=%d", fid, from), []byte(rest), 200, &f)
			if f.State != "ready" || f.SHA256 != sumOf([]byte(whole)) {
				t.Fatalf("the file ended as %+v, want the sum of %q", f, whole)
			}
			if left := files.keys(t, ""); strings.Contains(strings.Join(left, " "), fid+".parts/") {
				t.Fatalf("parts left behind once the file is stored: %v", left)
			}
		}

		t.Run("from where it was", func(t *testing.T) {
			fid := legacyUpload(t, s, st, files, 10, 5, map[int64]string{0: "hello"})
			finish(t, fid, 5, "world", "helloworld")
		})

		t.Run("started again under its id, it says how far it got", func(t *testing.T) {
			fid := legacyUpload(t, s, st, files, 6, 4, map[int64]string{0: "ab", 2: "cd"})
			var f uploaded
			s.call(t, s.owner, "", "POST", w+"/files?name=clip.bin&size=6&id="+fid, []byte("abcdef"), 200, &f)
			if f.State != "uploading" || f.Received != 4 {
				t.Fatalf("started again: %+v, want 4 bytes received", f)
			}
			finish(t, fid, 4, "ef", "abcdef")
		})

		t.Run("a part stored but never counted is left out", func(t *testing.T) {
			fid := legacyUpload(t, s, st, files, 10, 5, map[int64]string{0: "hello", 5: "XXXXX"})
			finish(t, fid, 5, "world", "helloworld")
		})

		t.Run("what is not there is asked for again", func(t *testing.T) {
			fid := legacyUpload(t, s, st, files, 15, 10, map[int64]string{0: "hello"})
			out := s.call(t, s.owner, "", "PATCH", w+"/files/"+fid+"?offset=10", []byte("again"), 409, nil)
			if !strings.Contains(out, "continue from 5") {
				t.Fatalf("a part sent after one that is lost: %s", out)
			}
			finish(t, fid, 5, "worldagain", "helloworldagain")
		})
	})
}

// TestAnUploadIsCheckedBeforeItIsReady: a file is made ready only when the
// bytes put together are as many as the size it was given, and match the
// checksum when one was given. When they do not, what was kept is let go
// and the caller is told to send the file again from the start.
func TestAnUploadIsCheckedBeforeItIsReady(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		files := &failingFiles{Store: disk}
		s := newSiteWithFiles(t, st, files)

		t.Run("a part cut short in storage", func(t *testing.T) {
			var f uploaded
			s.call(t, s.owner, "", "POST", w+"/files?name=clip.bin&size=10", []byte("hello"), 201, &f)
			for _, key := range files.keys(t, "") {
				if strings.Contains(key, f.ID+".parts/") {
					if err := files.Put(context.Background(), key, strings.NewReader("hel"), ""); err != nil {
						t.Fatal(err)
					}
				}
			}
			if out := s.call(t, s.owner, "", "PATCH", w+"/files/"+f.ID+"?offset=5", []byte("world"), 409, nil); !strings.Contains(out, "continue from 0") {
				t.Fatalf("finishing with a part short: %s", out)
			}
			var after uploaded // received is left out of the answer when it is 0
			s.call(t, s.owner, "", "GET", w+"/files/"+f.ID, nil, 200, &after)
			if after.State != "uploading" || after.Received != 0 {
				t.Fatalf("after the check failed the file is %+v", after)
			}
			s.call(t, s.owner, "", "PATCH", w+"/files/"+f.ID+"?offset=0", []byte("helloworld"), 200, &f)
			if f.State != "ready" || f.SHA256 != sumOf([]byte("helloworld")) {
				t.Fatalf("sent again, the file is %+v", f)
			}
		})

		t.Run("a checksum given", func(t *testing.T) {
			fid := id.New()
			sum := sumOf([]byte("hello"))
			if out := s.call(t, s.owner, "", "POST", w+"/files?name=a.txt&size=5&sha256="+sum+"&id="+fid, []byte("hellO"), 409, nil); !strings.Contains(out, "continue from 0") {
				t.Fatalf("bytes that do not match the checksum: %s", out)
			}
			var f uploaded
			s.call(t, s.owner, "", "PATCH", w+"/files/"+fid+"?offset=0", []byte("hello"), 200, &f)
			if f.State != "ready" || f.SHA256 != sum {
				t.Fatalf("sent again, the file is %+v", f)
			}
			s.call(t, s.owner, "", "POST", w+"/files?name=b.txt&sha256="+sum, []byte("hello"), 201, &f)
			if f.State != "ready" {
				t.Fatalf("bytes that match the checksum: %+v", f)
			}
			s.call(t, s.owner, "", "POST", w+"/files?name=c.txt&sha256=nope", []byte("hello"), 400, nil)
		})
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
		s.call(t, s.owner, "", "POST", path, data, 200, &other)
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
		s.call(t, s.owner, "", "POST", path, data, 200, &f)
		if f.State != "ready" || f.SHA256 != sumOf(data) {
			t.Fatalf("finished again, the file is %+v, want the sum %s", f, sumOf(data))
		}
		if left, _ := os.ReadDir(filepath.Join(s.dir, "uploads")); len(left) > 0 {
			t.Fatalf("left on this machine once the file is stored: %v", left)
		}
	})
}
