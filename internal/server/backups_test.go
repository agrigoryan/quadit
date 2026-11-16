package server_test

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestABackupOfANewerQuaditIsRefusedInWords: bringing a task back from a
// backup a newer Quadit made is refused, with words that say which Quadit
// can read it, and not as a task that is not found.
func TestABackupOfANewerQuaditIsRefusedInWords(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		var made struct {
			Backup struct{ ID string }
			ID     string
		}
		s.call(s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &made)
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
		out := s.call(s.owner, "", "POST", "/api/v1/admin/backups/"+bid+"/restore-item", M{"workspace": "games", "task": "SVA-1"}, 409, nil)
		if !strings.Contains(out, "Quadit 9.9.9") {
			t.Fatalf("the refusal does not say which Quadit can read the backup: %s", out)
		}
	})
}

// TestBringingAnItemBackAnswersWhatWentWrong: bringing a task back from a
// backup is answered not found only when the backup, the workspace or the
// task is not there; a damaged archive is refused; and a database that
// fails on the way is a failure, not a task that is not found.
func TestBringingAnItemBackAnswersWhatWentWrong(t *testing.T) {
	st := newFaultyStore(testdb.SQLite(t))
	s := newSite(t, st)
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	backupOf := func() (id, location string) {
		t.Helper()
		var made struct {
			Backup struct{ ID string }
			ID     string
		}
		s.call(s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &made)
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
		s.in(t).call(s.owner, "", "POST", "/api/v1/admin/backups/"+id+"/restore-item", body, want, nil)
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
	s.call(s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &first)
	s.call(s.owner, "", "POST", "/api/v1/admin/backups", M{}, 201, &second)
	if first.Location == "" || first.Location == second.Location {
		t.Fatalf("the two backups are at %q and %q; want two files", first.Location, second.Location)
	}
	for _, path := range []string{first.Location, second.Location} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("a backup's file is not there: %v", err)
		}
	}
}
