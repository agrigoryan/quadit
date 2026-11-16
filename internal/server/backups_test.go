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
