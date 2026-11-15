package sqlite

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// TestUpgradeAndBack upgrades a database made by an "older binary" (one
// that stops a schema version short), checks that a copy of it as it was
// is left beside it, and goes back to that copy. It does so in a plain data
// folder and in one whose name has the characters a file pattern gives
// meaning to.
func TestUpgradeAndBack(t *testing.T) {
	for _, folder := range []string{"data", "data [1] *?"} {
		t.Run(folder, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), folder)
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			upgradeAndBack(t, filepath.Join(dir, "quadit.sqlite"))
		})
	}
}

func upgradeAndBack(t *testing.T, path string) {
	t.Helper()
	ctx := context.Background()
	old, err := OpenAt(ctx, path, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, latest, _ := old.Pending(ctx)
	old.Close()
	if old, err = OpenAt(ctx, path, latest-1); err != nil {
		t.Fatal(err)
	}
	if err := old.Insert(ctx, core.Workspace{ID: id.New(), Slug: "games", Name: "Games", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	old.Close()
	os.Remove(Before(path, latest)) // the stand-in for the older binary made one on its way up

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := st.SchemaVersion(ctx); v != latest {
		t.Fatalf("after the upgrade: version %d, want %d", v, latest)
	}
	st.Close()
	if _, err := os.Stat(Before(path, latest)); err != nil {
		t.Fatalf("no copy from before the upgrade: %v", err)
	}

	if _, aside, err := UndoUpgrade(ctx, path); err != nil {
		t.Fatal(err)
	} else if _, err := os.Stat(aside); err != nil {
		t.Fatalf("the upgraded database was not kept: %v", err)
	}
	back, err := OpenAt(ctx, path, latest-1)
	if err != nil {
		t.Fatal(err)
	}
	defer back.Close()
	if v, _ := back.SchemaVersion(ctx); v != latest-1 {
		t.Fatalf("after going back: version %d, want %d", v, latest-1)
	}
	var got core.Workspace
	if err := back.Get(ctx, &got, store.Eq("slug", "games")); err != nil {
		t.Fatalf("the data after going back: %v", err)
	}
}
