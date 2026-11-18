package backup_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// The tests of an archive being the install at one moment, and of a full
// restore that is all or nothing.

// meanwhile is a store on which something happens while a backup reads
// it: during, just before the table named is read, and after, once every
// table is read.
type meanwhile struct {
	store.Store
	table         string
	during, after func()
}

func (s *meanwhile) Snapshot(ctx context.Context, fn func(store.Snapshot) error) error {
	err := s.Store.Snapshot(ctx, func(snap store.Snapshot) error { return fn(&meanwhileSnap{Snapshot: snap, s: s}) })
	if err == nil && s.after != nil {
		s.after()
	}
	return err
}

type meanwhileSnap struct {
	store.Snapshot
	s *meanwhile
}

func (snap *meanwhileSnap) Dump(ctx context.Context, table string, each func(map[string]any) error) error {
	if table == snap.s.table && snap.s.during != nil {
		snap.s.during()
		snap.s.during = nil
	}
	return snap.Snapshot.Dump(ctx, table, each)
}

// change applies one change as the owner, failing the test if it fails.
func change(t *testing.T, e *engine.Engine, ws core.Workspace, owner core.User, typ string, args M) {
	t.Helper()
	raw, _ := json.Marshal(args)
	if _, err := e.Apply(context.Background(), ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: typ, Args: raw}); err != nil {
		t.Fatalf("%s: %v", typ, err)
	}
}

// fresh is a new empty database of the same kind as st, with its file store.
func fresh(t *testing.T, st store.Store) (store.Store, *blob.Disk) {
	t.Helper()
	dst := testdb.SQLite(t)
	if st.Dialect() == "postgres" {
		dst = testdb.Postgres(t)
	}
	files, _ := blob.NewDisk(t.TempDir())
	return dst, files
}

// feedAgrees fails the test when a workspace of db has events numbered
// past its sequence: the next change there would reuse a number.
func feedAgrees(t *testing.T, db store.Store, wsID string) {
	t.Helper()
	var ws core.Workspace
	if err := db.Get(context.Background(), &ws, store.Eq("id", wsID)); err != nil {
		t.Fatal(err)
	}
	evs, err := db.In(wsID).Events(context.Background(), store.EventFilter{Desc: true, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) > 0 && evs[0].Seq > ws.Seq {
		t.Fatalf("the workspace's sequence is %d and its last event is %d", ws.Seq, evs[0].Seq)
	}
}

// TestAnArchiveIsTheInstallAtOneMoment: what is written while a backup
// reads the database is in none of its tables, so the archive's rows
// agree with each other, and the install restored from it goes on from
// where they say.
func TestAnArchiveIsTheInstallAtOneMoment(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		files, _ := blob.NewDisk(t.TempDir())
		ws, owner, e := fill(t, st, files)

		t.Run("a change made between two tables is in neither", func(t *testing.T) {
			before, err := st.Count(ctx, "tasks")
			if err != nil {
				t.Fatal(err)
			}
			busy := &meanwhile{Store: st, table: "events", during: func() {
				change(t, e, ws, owner, "task.create", M{"project": "SVA", "title": "Made while the backup ran"})
			}}
			var archive bytes.Buffer
			if _, err := backup.Write(ctx, busy, files, nil, "test", &archive); err != nil {
				t.Fatal(err)
			}
			if _, err := backup.Verify(bytes.NewReader(archive.Bytes())); err != nil {
				t.Fatalf("the archive does not verify: %v", err)
			}
			dst, dstFiles := fresh(t, st)
			if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(archive.Bytes())); err != nil {
				t.Fatal(err)
			}
			feedAgrees(t, dst, ws.ID)
			if n, err := dst.Count(ctx, "tasks"); err != nil || n != before {
				t.Fatalf("the restored install has %d tasks, want the %d there were when the backup began (%v)", n, before, err)
			}
		})

		t.Run("changes made all the while", func(t *testing.T) {
			stop := make(chan struct{})
			var wg sync.WaitGroup
			wg.Go(func() {
				for i := 0; ; i++ {
					select {
					case <-stop:
						return
					default:
					}
					raw, _ := json.Marshal(M{"project": "SVA", "title": fmt.Sprintf("Busy %d", i)})
					if _, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "task.create", Args: raw}); err != nil {
						t.Error(err)
						return
					}
				}
			})
			var archives [][]byte
			for range 3 {
				var archive bytes.Buffer
				if _, err := backup.Write(ctx, st, files, nil, "test", &archive); err != nil {
					t.Error(err)
				}
				archives = append(archives, archive.Bytes())
			}
			close(stop)
			wg.Wait()
			for i, archive := range archives {
				if _, err := backup.Verify(bytes.NewReader(archive)); err != nil {
					t.Fatalf("archive %d, made while changes were made, does not verify: %v", i+1, err)
				}
			}
			dst, dstFiles := fresh(t, st)
			if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(archives[len(archives)-1])); err != nil {
				t.Fatal(err)
			}
			feedAgrees(t, dst, ws.ID)
		})
	})
}

// TestAnArchiveHoldsTheFilesItsRowsName: a backup copies the stored files
// the rows it read name. One gone from file storage while the database
// still names it was lost before the backup: the archive says so and is
// good. One removed after the rows were read, with its row, would leave
// the archive without a file its rows name: the backup fails.
func TestAnArchiveHoldsTheFilesItsRowsName(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		files, _ := blob.NewDisk(t.TempDir())
		ws, _, _ := fill(t, st, files)
		var f core.File
		if err := st.In(ws.ID).Get(ctx, &f, store.Eq("name", "ring.png")); err != nil {
			t.Fatal(err)
		}
		// Left in file storage by nothing: not a file of the install.
		if err := files.Put(ctx, "stray/left-behind", strings.NewReader("x"), ""); err != nil {
			t.Fatal(err)
		}

		t.Run("the files the rows name, and only those", func(t *testing.T) {
			var archive bytes.Buffer
			m, err := backup.Write(ctx, st, files, nil, "test", &archive)
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, e := range m.Entries {
				if strings.HasPrefix(e.Name, "files/") {
					names = append(names, e.Name)
				}
			}
			if len(names) != 1 || names[0] != "files/"+f.StorageKey {
				t.Fatalf("the archive holds the files %v, want only %s", names, f.StorageKey)
			}
		})

		t.Run("a file removed with its row after the rows were read fails the backup", func(t *testing.T) {
			gone := &meanwhile{Store: st, after: func() {
				if _, err := st.In(ws.ID).Delete(ctx, "attachments", store.Eq("file_id", f.ID)); err != nil {
					t.Fatal(err)
				}
				if _, err := st.In(ws.ID).Delete(ctx, "files", store.Eq("id", f.ID)); err != nil {
					t.Fatal(err)
				}
				if err := files.Delete(ctx, f.StorageKey); err != nil {
					t.Fatal(err)
				}
			}}
			_, err := backup.Write(ctx, gone, files, nil, "test", io.Discard)
			if err == nil || !strings.Contains(err.Error(), "removed while the backup ran") {
				t.Fatalf("a backup missing a file its rows name: %v", err)
			}
		})

		t.Run("a file lost before the backup is said to be", func(t *testing.T) {
			lost := core.File{ID: id.New(), WorkspaceID: ws.ID, Name: "lost.png", ContentType: "image/png", Size: 3, State: core.FileReady, UploadedBy: f.UploadedBy, CreatedAt: 1}
			lost.StorageKey = ws.ID + "/" + lost.ID
			if err := st.In(ws.ID).Insert(ctx, lost); err != nil {
				t.Fatal(err)
			}
			var archive bytes.Buffer
			m, err := backup.Write(ctx, st, files, nil, "test", &archive)
			if err != nil {
				t.Fatal(err)
			}
			if len(m.Missing) != 1 || m.Missing[0] != lost.StorageKey {
				t.Fatalf("the archive says %v are missing, want %s", m.Missing, lost.StorageKey)
			}
			if _, err := backup.Verify(bytes.NewReader(archive.Bytes())); err != nil {
				t.Fatalf("an archive that says which file was lost does not verify: %v", err)
			}
		})
	})
}

// rewrite remakes an archive with each member's body as change gives it
// (nil leaves the member out), and a manifest that agrees, as one written
// that way would have.
func rewrite(t *testing.T, archive []byte, change func(name string, body []byte) []byte) []byte {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var out bytes.Buffer
	gw := gzip.NewWriter(&out)
	tw := tar.NewWriter(gw)
	var entries []backup.Entry
	var m backup.Manifest
	put := func(name string, body []byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Size: int64(len(body)), Mode: 0o600}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == "manifest.json" {
			if err := json.Unmarshal(body, &m); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if body = change(h.Name, body); body == nil {
			continue
		}
		sum := sha256.Sum256(body)
		entries = append(entries, backup.Entry{Name: h.Name, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])})
		put(h.Name, body)
	}
	m.Entries = entries
	raw, _ := json.Marshal(m)
	put("manifest.json", raw)
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// TestVerifyChecksTheRowsAgainstEachOther: an archive whose every member
// matches its checksum is still damaged when its rows disagree in a way a
// restored install would trip over.
func TestVerifyChecksTheRowsAgainstEachOther(t *testing.T) {
	ctx := context.Background()
	st := testdb.SQLite(t)
	files, _ := blob.NewDisk(t.TempDir())
	fill(t, st, files)
	var archive bytes.Buffer
	if _, err := backup.Write(ctx, st, files, nil, "test", &archive); err != nil {
		t.Fatal(err)
	}
	same := rewrite(t, archive.Bytes(), func(_ string, body []byte) []byte { return body })
	if _, err := backup.Verify(bytes.NewReader(same)); err != nil {
		t.Fatalf("the archive remade as it was does not verify: %v", err)
	}
	for name, change := range map[string]func(string, []byte) []byte{
		"a workspace whose feed is ahead of its sequence": func(name string, body []byte) []byte {
			if name != "db/workspaces.jsonl" {
				return body
			}
			var row M
			if err := json.Unmarshal(bytes.TrimSpace(body), &row); err != nil {
				t.Fatal(err)
			}
			row["seq"] = 1
			raw, _ := json.Marshal(row)
			return append(raw, '\n')
		},
		"a stored file its rows name and it does not hold": func(name string, body []byte) []byte {
			if strings.HasPrefix(name, "files/") {
				return nil
			}
			return body
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := backup.Verify(bytes.NewReader(rewrite(t, archive.Bytes(), change))); !errors.Is(err, backup.ErrDamaged) {
				t.Fatalf("verify = %v, want it damaged", err)
			}
		})
	}
}

// failingLoad is a store whose full restore fails when it comes to the
// rows of one table.
type failingLoad struct {
	store.Store
	table string
}

func (s *failingLoad) Restore(ctx context.Context, fn func(store.Loader) error) error {
	return s.Store.Restore(ctx, func(l store.Loader) error { return fn(&failingLoader{Loader: l, table: s.table}) })
}

type failingLoader struct {
	store.Loader
	table string
}

func (l *failingLoader) Load(ctx context.Context, table string, rows []map[string]any) error {
	if table == l.table {
		return errFault
	}
	return l.Loader.Load(ctx, table, rows)
}

// emptyAfterwards fails the test unless a database and a file store are as
// empty as before a restore.
func emptyAfterwards(t *testing.T, st store.Store, files blob.Store) {
	t.Helper()
	for _, tb := range store.Tables() {
		if n, err := st.Count(context.Background(), tb.Name); err != nil || n != 0 {
			t.Fatalf("a failed restore left %d rows in %s (%v)", n, tb.Name, err)
		}
	}
	stored := 0
	if err := files.List(context.Background(), "", func(string, int64) error { stored++; return nil }); err != nil || stored != 0 {
		t.Fatalf("a failed restore left %d stored files (%v)", stored, err)
	}
}

// TestAFailedRestoreLeavesNothingAndCanRunAgain: a full restore that
// fails, because the archive is damaged near its end or because a table
// cannot be loaded, leaves the database and file storage empty, and the
// same restore then runs again.
func TestAFailedRestoreLeavesNothingAndCanRunAgain(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		files, _ := blob.NewDisk(t.TempDir())
		fill(t, st, files)
		var archive bytes.Buffer
		if _, err := backup.Write(ctx, st, files, nil, "test", &archive); err != nil {
			t.Fatal(err)
		}
		good := archive.Bytes()

		t.Run("an archive cut short", func(t *testing.T) {
			dst, dstFiles := fresh(t, st)
			short := good[:len(good)-200]
			if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(short)); !errors.Is(err, backup.ErrDamaged) {
				t.Fatalf("restoring an archive cut short = %v, want it damaged", err)
			}
			emptyAfterwards(t, dst, dstFiles)
			if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(good)); err != nil {
				t.Fatalf("the restore run again: %v", err)
			}
		})

		t.Run("a table that cannot be loaded", func(t *testing.T) {
			dst, dstFiles := fresh(t, st)
			if _, err := backup.Restore(ctx, &failingLoad{Store: dst, table: "comments"}, dstFiles, nil, bytes.NewReader(good)); !errors.Is(err, errFault) {
				t.Fatalf("a restore whose load fails = %v, want the load's error", err)
			}
			emptyAfterwards(t, dst, dstFiles)
			if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(good)); err != nil {
				t.Fatalf("the restore run again: %v", err)
			}
		})
	})
}

// TestARestoreNeedsTheSecretThatSealedTheArchive: an archive says, sealed,
// which install secret sealed its stored secrets. A full restore with
// another secret is refused before anything is written; with the same
// one it goes ahead, and so it does when the caller says the secret is
// lost.
func TestARestoreNeedsTheSecretThatSealedTheArchive(t *testing.T) {
	ctx := context.Background()
	st := testdb.SQLite(t)
	files, _ := blob.NewDisk(t.TempDir())
	original, _ := auth.NewSealer([]byte("the original install secret"))
	other, _ := auth.NewSealer([]byte("a secret made by a new install"))
	fill(t, st, files)
	var archive bytes.Buffer
	if _, err := backup.Write(ctx, st, files, original, "test", &archive); err != nil {
		t.Fatal(err)
	}

	t.Run("another secret is refused", func(t *testing.T) {
		dst, dstFiles := fresh(t, st)
		if _, err := backup.Restore(ctx, dst, dstFiles, other, bytes.NewReader(archive.Bytes())); !errors.Is(err, backup.ErrOtherSecret) {
			t.Fatalf("restoring with another secret = %v", err)
		}
		emptyAfterwards(t, dst, dstFiles)
	})
	t.Run("the same secret", func(t *testing.T) {
		dst, dstFiles := fresh(t, st)
		if _, err := backup.Restore(ctx, dst, dstFiles, original, bytes.NewReader(archive.Bytes())); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a secret said to be lost", func(t *testing.T) {
		dst, dstFiles := fresh(t, st)
		if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(archive.Bytes())); err != nil {
			t.Fatal(err)
		}
	})
}

// TestARestoreOfAnArchiveWithoutAKeyCheckTriesWhatItSealed: an archive
// made before archives carried a key check (or made without the install's
// secret) is held to the same rule by what it holds: a restore with a
// secret that opens none of its stored secrets is refused before anything
// is written, one with the secret that sealed them goes ahead, and so does
// one that says the secret is lost. An archive that holds no stored secret
// has nothing a wrong secret could lose.
func TestARestoreOfAnArchiveWithoutAKeyCheckTriesWhatItSealed(t *testing.T) {
	ctx := context.Background()
	original, _ := auth.NewSealer([]byte("the original install secret"))
	other, _ := auth.NewSealer([]byte("a secret made by a new install"))
	archiveOf := func(t *testing.T, sealSomething bool) []byte {
		t.Helper()
		st := testdb.SQLite(t)
		files, _ := blob.NewDisk(t.TempDir())
		fill(t, st, files)
		if sealSomething {
			// A mail password, sealed inside the setting's JSON as the
			// admin area keeps it.
			sealed, err := original.Seal("a mail password")
			if err != nil {
				t.Fatal(err)
			}
			mail := core.Setting{Name: "mail", Value: json.RawMessage(`{"host":"smtp.example.com","password":"` + sealed + `"}`), UpdatedAt: 1}
			if err := st.Insert(ctx, mail); err != nil {
				t.Fatal(err)
			}
		}
		var archive bytes.Buffer
		if _, err := backup.Write(ctx, st, files, nil, "test", &archive); err != nil {
			t.Fatal(err)
		}
		return archive.Bytes()
	}
	withSecrets := archiveOf(t, true)

	t.Run("another secret is refused", func(t *testing.T) {
		dst, dstFiles := fresh(t, testdb.SQLite(t))
		if _, err := backup.Restore(ctx, dst, dstFiles, other, bytes.NewReader(withSecrets)); !errors.Is(err, backup.ErrOtherSecret) {
			t.Fatalf("restoring with another secret = %v", err)
		}
		emptyAfterwards(t, dst, dstFiles)
	})
	t.Run("the secret that sealed it", func(t *testing.T) {
		dst, dstFiles := fresh(t, testdb.SQLite(t))
		if _, err := backup.Restore(ctx, dst, dstFiles, original, bytes.NewReader(withSecrets)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a secret said to be lost", func(t *testing.T) {
		dst, dstFiles := fresh(t, testdb.SQLite(t))
		if _, err := backup.Restore(ctx, dst, dstFiles, nil, bytes.NewReader(withSecrets)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("nothing sealed", func(t *testing.T) {
		dst, dstFiles := fresh(t, testdb.SQLite(t))
		if _, err := backup.Restore(ctx, dst, dstFiles, other, bytes.NewReader(archiveOf(t, false))); err != nil {
			t.Fatal(err)
		}
	})
}
