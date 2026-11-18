package backup_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"gocloud.dev/blob/memblob"
)

// TestCopiesOfABackup: a backup's file is copied to a folder or a bucket
// under its own name, and only the newest copies there are kept; what is
// not a backup's file is left alone.
func TestCopiesOfABackup(t *testing.T) {
	ctx := context.Background()
	b := memblob.OpenBucket(nil)
	defer b.Close()
	for name, to := range map[string]struct {
		store blob.Store
		dir   string
	}{
		"a folder":                         {&blob.Disk{Root: t.TempDir()}, ""},
		"a bucket":                         {blob.FromBucket(b, "s3", "quadit/"), ""},
		"a folder inside the file storage": {&blob.Disk{Root: t.TempDir()}, "backups/"},
	} {
		t.Run(name, func(t *testing.T) {
			local := t.TempDir()
			if err := to.store.Put(ctx, to.dir+"notes.txt", strings.NewReader("mine"), ""); err != nil {
				t.Fatal(err)
			}
			at := time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC)
			var names []string
			for day := range 4 {
				f, err := backup.NewFile(local, at.AddDate(0, 0, day))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.WriteString("archive " + f.Name()); err != nil {
					t.Fatal(err)
				}
				f.Close()
				if err := backup.Copy(ctx, f.Name(), to.store, to.dir); err != nil {
					t.Fatal(err)
				}
				names = append(names, filepath.Base(f.Name()))
			}
			r, _, err := to.store.Open(ctx, to.dir+names[3])
			if err != nil {
				t.Fatal(err)
			}
			got, _ := io.ReadAll(r)
			r.Close()
			if want := "archive " + filepath.Join(local, names[3]); string(got) != want {
				t.Fatalf("the copy holds %q, want %q", got, want)
			}

			if err := backup.DropOldCopies(ctx, to.store, to.dir, 2); err != nil {
				t.Fatal(err)
			}
			var kept []string
			if err := to.store.List(ctx, to.dir, func(k string, _ int64) error { kept = append(kept, k); return nil }); err != nil {
				t.Fatal(err)
			}
			slices.Sort(kept)
			want := []string{to.dir + "notes.txt", to.dir + names[2], to.dir + names[3]}
			slices.Sort(want)
			if !slices.Equal(kept, want) {
				t.Fatalf("kept %v, want %v", kept, want)
			}
		})
	}
	t.Run("a folder that is gone is not made again", func(t *testing.T) {
		gone := filepath.Join(t.TempDir(), "unmounted")
		f, err := backup.NewFile(t.TempDir(), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		if err := backup.Copy(ctx, f.Name(), &blob.Disk{Root: gone}, ""); err == nil {
			t.Fatal("a copy to a folder that is not there succeeded")
		}
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("the copy made the folder: %v", err)
		}
	})
}
