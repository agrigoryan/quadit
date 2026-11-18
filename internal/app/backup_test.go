package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// TestARestoreBringsTheInstallSecretOrSaysItIsLost: the archive does not
// hold the install secret. A full restore into a new install, which made
// a secret of its own, is refused until it is given the original
// (--secret-key), which the install then keeps, so what the archive sealed
// opens again; or until it is told the original is lost
// (--without-secret-key).
func TestARestoreBringsTheInstallSecretOrSaysItIsLost(t *testing.T) {
	t.Setenv("QUADIT_SECRET", "")
	t.Setenv("QUADIT_DATA", "")
	t.Setenv("QUADIT_DB", "")
	ctx := context.Background()
	src := setUpInstall(t)
	// A secret in the vault, sealed with the install's secret.
	o := Options{Data: src}
	st, sealer, err := o.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ws core.Workspace
	var owner core.Member
	if err := st.Get(ctx, &ws, store.Eq("slug", "test")); err != nil {
		t.Fatal(err)
	}
	if err := st.In(ws.ID).Get(ctx, &owner, store.Eq("role", "owner")); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]string{"name": "DEPLOY_TOKEN", "value": "s3cr3t"})
	if _, err := engine.New(st, sealer.Seal).Apply(ctx, ws.ID, engine.Actor{UserID: owner.UserID}, engine.Change{ID: id.New(), Type: "secret.set", Args: raw}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	archive := filepath.Join(t.TempDir(), "quadit.tar.gz")
	stdoutOf(t, func() {
		if code := Backup([]string{"--data", src, "--out", archive}, "test"); code != 0 {
			t.Fatalf("backup: exit %d", code)
		}
	})
	restore := func(dst string, flags ...string) int {
		var code int
		stdoutOf(t, func() { code = Restore(append([]string{archive, "--data", dst}, flags...), "test") })
		return code
	}
	users := func(dst string) int {
		st, _, err := (&Options{Data: dst}).Open(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer st.Close()
		n, err := st.Count(ctx, "users")
		if err != nil {
			t.Fatal(err)
		}
		return n
	}

	t.Run("with the new install's own secret it is refused", func(t *testing.T) {
		dst := t.TempDir()
		if code := restore(dst); code != 1 {
			t.Fatalf("exit %d", code)
		}
		if n := users(dst); n != 0 {
			t.Fatalf("the refused restore wrote %d users", n)
		}
	})

	t.Run("given the original secret, it is restored and kept", func(t *testing.T) {
		dst := t.TempDir()
		if code := restore(dst, "--secret-key", filepath.Join(src, "secret.key")); code != 0 {
			t.Fatalf("exit %d", code)
		}
		want, _ := os.ReadFile(filepath.Join(src, "secret.key"))
		if got, err := os.ReadFile(filepath.Join(dst, "secret.key")); err != nil || string(got) != string(want) {
			t.Fatalf("the restored install's secret is not the original (%v)", err)
		}
		st, sealer, err := (&Options{Data: dst}).Open(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer st.Close()
		var sec core.Secret
		if err := st.In(ws.ID).Get(ctx, &sec, store.Eq("name", "DEPLOY_TOKEN")); err != nil {
			t.Fatal(err)
		}
		if plain, err := sealer.Open(sec.Value); err != nil || plain != "s3cr3t" {
			t.Fatalf("the vault's secret opens as %q, %v", plain, err)
		}
	})

	t.Run("said to be lost, the rest is restored", func(t *testing.T) {
		dst := t.TempDir()
		if code := restore(dst, "--without-secret-key"); code != 0 {
			t.Fatalf("exit %d", code)
		}
		if n := users(dst); n == 0 {
			t.Fatal("nothing was restored")
		}
	})
}
