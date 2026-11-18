package server_test

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestABackupOfANewerQuaditIsRefusedInWords: bringing a task back from a
// backup a newer Quadit made is refused, with words that say which Quadit
// can read it, and not as a task that is not found.
func TestABackupOfANewerQuaditIsRefusedInWords(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		var made struct {
			Backup struct{ ID string }
			ID     string
		}
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &made)
		bid := made.Backup.ID
		if bid == "" {
			bid = made.ID
		}
		var b core.Backup
		if err := st.Get(context.Background(), &b, store.Eq("id", bid)); err != nil {
			t.Fatal(err)
		}
		// The archive as a newer Quadit begins it.
		f, err := os.Create(b.Location)
		if err != nil {
			t.Fatal(err)
		}
		gz := gzip.NewWriter(f)
		tw := tar.NewWriter(gz)
		head := `{"schema":999,"version":"9.9.9"}`
		if err := tw.WriteHeader(&tar.Header{Name: "schema.json", Size: int64(len(head)), Mode: 0o600}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(head)); err != nil {
			t.Fatal(err)
		}
		for _, closer := range []interface{ Close() error }{tw, gz, f} {
			if err := closer.Close(); err != nil {
				t.Fatal(err)
			}
		}
		out := s.call(t, s.owner, "", "POST", "/api/v1/admin/backups/"+bid+"/restore-item", M{"workspace": "games", "task": "SVA-1"}, 409, nil)
		if !strings.Contains(out, "Quadit 9.9.9") {
			t.Fatalf("the refusal does not say which Quadit can read the backup: %s", out)
		}
	})
}

// TestBringingAnItemBackAnswersWhatWentWrong: bringing a task back from a
// backup is answered not found only when the backup, the workspace or the
// task is not there; a damaged archive is refused; and a database that
// fails on the way is a failure, not a task that is not found, that leaves
// the task as it was.
func TestBringingAnItemBackAnswersWhatWentWrong(t *testing.T) {
	st := newFaultyStore(testdb.SQLite(t))
	s := newSite(t, st)
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	backupOf := func() (id, location string) {
		t.Helper()
		var made struct {
			Backup struct{ ID string }
			ID     string
		}
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &made)
		id = made.Backup.ID
		if id == "" {
			id = made.ID
		}
		var b core.Backup
		if err := st.Get(context.Background(), &b, store.Eq("id", id)); err != nil {
			t.Fatal(err)
		}
		return id, b.Location
	}
	restore := func(t *testing.T, id string, body M, want int) {
		t.Helper()
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups/"+id+"/restore-item", body, want, nil)
	}
	good, _ := backupOf()

	t.Run("what is not there is not found", func(t *testing.T) {
		restore(t, good, M{"workspace": "games", "task": "SVA-99"}, 404)
		restore(t, good, M{"workspace": "nope", "task": "SVA-1"}, 404)
		restore(t, "no-such-backup", M{"workspace": "games", "task": "SVA-1"}, 404)
	})
	t.Run("a database that fails is a failure", func(t *testing.T) {
		st.faults.set("count tasks")
		defer st.faults.clear()
		restore(t, good, M{"workspace": "games", "task": "SVA-1"}, 500)
	})
	t.Run("a failure part way leaves the task as it was", func(t *testing.T) {
		s.change(t, s.owner, "", "task.update", M{"id": "SVA-1", "title": "Renamed after the backup"})
		ctx := context.Background()
		var ws core.Workspace
		if err := st.Get(ctx, &ws, store.Eq("slug", "games")); err != nil {
			t.Fatal(err)
		}
		// The rows are set back first; telling the feed fails after.
		fired := st.faults.arm(fault{op: "update", table: "tasks", times: 1})
		restore(t, good, M{"workspace": "games", "task": "SVA-1"}, 500)
		if fired() != 1 {
			t.Fatalf("the fault fired %d times", fired())
		}
		var task core.Task
		if err := st.In(ws.ID).Get(ctx, &task, store.Eq("key", "SVA-1")); err != nil || task.Title != "Renamed after the backup" {
			t.Fatalf("after a failed restore the task is %q (%v), want it as it was before the attempt", task.Title, err)
		}
		var now core.Workspace
		if err := st.Get(ctx, &now, store.Eq("id", ws.ID)); err != nil || now.Seq != ws.Seq {
			t.Fatalf("a failed restore moved the feed from %d to %d (%v)", ws.Seq, now.Seq, err)
		}
	})
	restore(t, good, M{"workspace": "games", "task": "SVA-1"}, 200)
	t.Run("a damaged archive is refused", func(t *testing.T) {
		damaged, location := backupOf()
		if err := os.WriteFile(location, []byte("not an archive"), 0o600); err != nil {
			t.Fatal(err)
		}
		restore(t, damaged, M{"workspace": "games", "task": "SVA-1"}, 409)
	})
}

// TestTwoBackupsInOneSecondAreTwoFiles: a backup is named for the second it
// is taken in; a second one in that same second gets its own file instead of
// writing over the first.
func TestTwoBackupsInOneSecondAreTwoFiles(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	var first, second struct{ Location string }
	s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &first)
	s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &second)
	if first.Location == "" || first.Location == second.Location {
		t.Fatalf("the two backups are at %q and %q; want two files", first.Location, second.Location)
	}
	for _, path := range []string{first.Location, second.Location} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("a backup's file is not there: %v", err)
		}
	}
}

// TestAPurgedFileStaysInStorageADay: emptying the trash takes a file's
// rows out at once and its bytes a day later, so a backup that read the
// rows before they went still finds the bytes to copy.
func TestAPurgedFileStaysInStorageADay(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		newSiteWithFiles(t, st, disk)
		var ws core.Workspace
		if err := st.Get(ctx, &ws, store.Eq("slug", "games")); err != nil {
			t.Fatal(err)
		}
		var owner core.Member
		if err := st.In(ws.ID).Get(ctx, &owner, store.Eq("role", "owner")); err != nil {
			t.Fatal(err)
		}
		long := time.Now().Add(-31 * 24 * time.Hour).UnixMilli()
		f := core.File{ID: id.New(), WorkspaceID: ws.ID, Name: "old.png", ContentType: "image/png", Size: 3, State: core.FileReady,
			UploadedBy: owner.UserID, CreatedAt: long, DeletedAt: long}
		f.StorageKey = ws.ID + "/" + f.ID
		if err := disk.Put(ctx, f.StorageKey, strings.NewReader("PNG"), ""); err != nil {
			t.Fatal(err)
		}
		if err := st.In(ws.ID).Insert(ctx, f); err != nil {
			t.Fatal(err)
		}
		stored := func() bool {
			r, _, err := disk.Open(ctx, f.StorageKey)
			if err == nil {
				r.Close()
			}
			return err == nil
		}
		if err := st.Insert(ctx, core.Job{ID: id.New(), Kind: "trash.purge", RunAt: time.Now().UnixMilli(), CreatedAt: time.Now().UnixMilli()}); err != nil {
			t.Fatal(err)
		}
		eventually(t, "the trash to be emptied of the file's row", func() bool {
			n, err := st.Count(ctx, "files", store.Eq("id", f.ID))
			return err == nil && n == 0
		})
		if !stored() {
			t.Fatal("the file's bytes went with its row")
		}
		var removal []core.Job
		if err := st.List(ctx, &removal, store.Where(store.Eq("kind", "files.remove"))); err != nil || len(removal) != 1 {
			t.Fatalf("the removal of the bytes is queued as %+v (%v)", removal, err)
		}
		if wait := time.Until(time.UnixMilli(removal[0].RunAt)); wait < 23*time.Hour {
			t.Fatalf("the bytes are to be removed in %s, want a day", wait)
		}
		// A day later.
		if _, err := st.Update(ctx, "jobs", map[string]any{"run_at": time.Now().UnixMilli()}, store.Eq("id", removal[0].ID)); err != nil {
			t.Fatal(err)
		}
		eventually(t, "the bytes to be removed a day later", func() bool { return !stored() })
	})
}

// TestEachBackupIsCopiedWhereTheSettingSays: every backup, once verified,
// is copied to a folder on the server or to file storage; its record says
// when the copy got there; and only the newest the setting keeps are kept
// there, as they are beside the data.
func TestEachBackupIsCopiedWhereTheSettingSays(t *testing.T) {
	for _, to := range []struct {
		name, dir string
		copyTo    func(folder string) M
	}{
		{"a folder", "", func(folder string) M { return M{"kind": "folder", "folder": folder} }},
		{"file storage", "backups/", func(string) M { return M{"kind": "files"} }},
	} {
		t.Run(to.name, func(t *testing.T) {
			testdb.Each(t, func(t *testing.T, st store.Store) {
				ctx := context.Background()
				files, err := blob.NewDisk(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				s := newSiteWithFiles(t, st, files)
				folder := t.TempDir()
				copies := map[string]blob.Store{"": &blob.Disk{Root: folder}, "backups/": files}[to.dir]
				s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/backup", M{"keep": 2, "copy_to": to.copyTo(folder)}, 200, nil)
				var made []core.Backup
				for range 3 {
					var b core.Backup
					s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &b)
					if b.CopiedAt == 0 || b.CopyError != "" {
						t.Fatalf("the backup's copy is recorded as made at %d, failed with %q", b.CopiedAt, b.CopyError)
					}
					made = append(made, b)
				}
				var kept []string
				if err := copies.List(ctx, to.dir, func(k string, _ int64) error { kept = append(kept, k); return nil }); err != nil {
					t.Fatal(err)
				}
				slices.Sort(kept)
				want := []string{to.dir + filepath.Base(made[1].Location), to.dir + filepath.Base(made[2].Location)}
				if !slices.Equal(kept, want) {
					t.Fatalf("the copies are %v, want the newest two: %v", kept, want)
				}
				var listed struct{ Backups []core.Backup }
				s.call(t, s.owner, "", "GET", "/api/v1/admin/backups", nil, 200, &listed)
				if listed.Backups[0].ID != made[2].ID || listed.Backups[0].CopiedAt != made[2].CopiedAt {
					t.Fatalf("the list shows the newest backup as %+v", listed.Backups[0])
				}
			})
		})
	}
}

// TestACopyThatFailsLeavesTheBackupAndSaysWhy: a backup whose copy cannot
// be made is kept, verified, with why the copy failed on its record, shown
// in the list, in the install's health and on the workspace dashboard; and
// the copies made before are not dropped for it.
func TestACopyThatFailsLeavesTheBackupAndSaysWhy(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		folder := filepath.Join(t.TempDir(), "drive")
		if err := os.Mkdir(folder, 0o750); err != nil {
			t.Fatal(err)
		}
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/backup", M{"keep": 1, "copy_to": M{"kind": "folder", "folder": folder}}, 200, nil)
		var first core.Backup
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &first)
		// The drive is taken away; what was on it stays where it went.
		moved := folder + "-elsewhere"
		if err := os.Rename(folder, moved); err != nil {
			t.Fatal(err)
		}

		var b core.Backup
		s.call(t, s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &b)
		if b.VerifiedAt == 0 || b.Error != "" || b.CopiedAt != 0 || !strings.Contains(b.CopyError, folder) {
			t.Fatalf("the backup is recorded as verified at %d, error %q, copied at %d, copy error %q", b.VerifiedAt, b.Error, b.CopiedAt, b.CopyError)
		}
		if _, err := os.Stat(b.Location); err != nil {
			t.Fatalf("the backup whose copy failed is not kept: %v", err)
		}
		if _, err := os.Stat(folder); !os.IsNotExist(err) {
			t.Fatalf("the copy made the folder that was gone again: %v", err)
		}
		var health struct {
			LastBackup core.Backup `json:"last_backup"`
		}
		s.call(t, s.owner, "", "GET", "/api/v1/admin/health", nil, 200, &health)
		if health.LastBackup.ID != b.ID || health.LastBackup.CopyError != b.CopyError {
			t.Fatalf("the install's health shows the last backup as %+v", health.LastBackup)
		}
		var board struct {
			Health struct {
				CopyFailed bool `json:"last_backup_copy_failed"`
			}
		}
		s.call(t, s.owner, "", "GET", w+"/dashboard", nil, 200, &board)
		if !board.Health.CopyFailed {
			t.Fatal("the dashboard does not say the last backup was not copied")
		}

		// The drive is back: the copy made before the failure is still there.
		if err := os.Rename(moved, folder); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(folder, filepath.Base(first.Location))); err != nil {
			t.Fatalf("a failed copy dropped the copy before it: %v", err)
		}
	})
}

// TestADestinationThatCannotBeUsedIsRefused: saving where backups are
// copied tries it first, and refuses, saying why, a folder that is not
// there, not absolute or cannot be written, and a bucket that does not
// answer.
func TestADestinationThatCannotBeUsedIsRefused(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	locked := t.TempDir()
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) }) // so the test's folder can be removed
	for name, c := range map[string]struct {
		copyTo M
		says   string
	}{
		"a folder that is not there":      {M{"kind": "folder", "folder": filepath.Join(t.TempDir(), "nope")}, "nope"},
		"a folder that is not absolute":   {M{"kind": "folder", "folder": "backups"}, "absolute"},
		"a folder that cannot be written": {M{"kind": "folder", "folder": locked}, "test write"},
		"a bucket that does not answer":   {M{"kind": "bucket", "bucket": M{"kind": "s3", "bucket": "quadit", "endpoint": "http://127.0.0.1:1", "access_key": "a", "secret_key": "b", "region": "us-east-1"}}, "bucket"},
		"a bucket of no cloud":            {M{"kind": "bucket", "bucket": M{"kind": "disk"}}, "s3, gcs or azure"},
		"a kind there is not":             {M{"kind": "tape"}, "tape"},
	} {
		t.Run(name, func(t *testing.T) {
			if name == "a folder that cannot be written" && os.Geteuid() == 0 {
				t.Skip("root writes to any folder")
			}
			out := s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/backup", M{"copy_to": c.copyTo}, 400, nil)
			if !strings.Contains(out, c.says) {
				t.Fatalf("the refusal does not say %q: %s", c.says, out)
			}
		})
	}
}
