package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// TestUpgradeAndBack upgrades a database made by an "older binary" (one
// that stops a schema version short), checks that a copy of it as it was
// is left beside it, and goes back to that copy.
func TestUpgradeAndBack(t *testing.T) {
	base := os.Getenv("QUADIT_TEST_POSTGRES")
	if base == "" {
		t.Skip("QUADIT_TEST_POSTGRES is not set")
	}
	ctx := context.Background()
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := fmt.Sprintf("quadit_upg_%d", time.Now().UnixNano())
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(base)
	u.Path = "/" + name
	dbURL := u.String()
	versionOf := func(database string) int {
		v := *u
		v.Path = "/" + database
		db, err := sql.Open("pgx", v.String())
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var n int
		if err := db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&n); err != nil {
			t.Fatalf("%s: %v", database, err)
		}
		return n
	}

	// The older binary: everything but the newest schema version, with data.
	old, err := OpenAt(ctx, dbURL, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, latest, _ := old.Pending(ctx)
	old.Close()
	if old, err = OpenAt(ctx, dbURL, latest-1); err != nil {
		t.Fatal(err)
	}
	ws := core.Workspace{ID: id.New(), Slug: "games", Name: "Games", CreatedAt: 1, UpdatedAt: 1}
	if err := old.Insert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	old.Close()
	t.Cleanup(func() {
		for _, d := range []string{name, Before(name, latest), fmt.Sprintf("%s_after_v%d", name, latest)} {
			admin.Exec(`DROP DATABASE IF EXISTS ` + d + ` WITH (FORCE)`)
		}
	})

	// The new binary upgrades it, and leaves a copy as it was.
	st, err := Open(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	var got core.Workspace
	if err := st.Get(ctx, &got, store.Eq("slug", "games")); err != nil {
		t.Fatalf("the data after the upgrade: %v", err)
	}
	st.Close()
	if v := versionOf(name); v != latest {
		t.Fatalf("after the upgrade the database is at version %d, want %d", v, latest)
	}
	if v := versionOf(Before(name, latest)); v != latest-1 {
		t.Fatalf("the copy is at version %d, want %d", v, latest-1)
	}

	// Going back: the copy takes the database's place, the upgraded one is kept.
	from, aside, err := UndoUpgrade(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	if v := versionOf(name); v != latest-1 {
		t.Fatalf("after going back (%s -> %s) the database is at version %d, want %d", from, aside, v, latest-1)
	}
	if v := versionOf(aside); v != latest {
		t.Fatalf("the upgraded database was not kept: version %d", v)
	}
	// And the older binary opens it as if nothing had happened.
	old, err = OpenAt(ctx, dbURL, latest-1)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if err := old.Get(ctx, &got, store.Eq("slug", "games")); err != nil {
		t.Fatalf("the data after going back: %v", err)
	}
}
