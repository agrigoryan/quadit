package settings_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/settings"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestACheckRefusesAValueWrittenWrong: a setting that decides access, set
// by the environment to something that is not of its shape, is not taken
// as unset: Checked says so, and the caller refuses. Get, for what decides
// no access, reads it as unset.
func TestACheckRefusesAValueWrittenWrong(t *testing.T) {
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	st := testdb.SQLite(t)
	table := settings.Table{"auth.require_2fa": {Shape: func() any { return new(bool) }}}
	set := settings.New(st, sealer, slog.Default(), table)
	t.Setenv(settings.EnvName("auth.require_2fa"), "maybe")
	if _, err := set.CheckedBool(context.Background(), "auth.require_2fa", false); err == nil {
		t.Fatal("a value that is not yes or no was taken as unset by a check that decides access")
	}
	if set.Bool(context.Background(), "auth.require_2fa", false) {
		t.Fatal("Get read a value written wrong as set")
	}
	t.Setenv(settings.EnvName("auth.require_2fa"), "true")
	set = settings.New(st, sealer, slog.Default(), table) // a value read is kept a few seconds
	if on, err := set.CheckedBool(context.Background(), "auth.require_2fa", false); err != nil || !on {
		t.Fatalf("a value written right reads as %v, %v", on, err)
	}
}

// TestASecretInANestedObjectIsSealed: a secret named by a dotted path, a
// field of an object inside the setting, is stored sealed, listed masked,
// read plain, and kept when sent back masked or left out.
func TestASecretInANestedObjectIsSealed(t *testing.T) {
	ctx := context.Background()
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	st := testdb.SQLite(t)
	type bucket struct {
		Name      string `json:"name"`
		SecretKey string `json:"secret_key"`
	}
	type shape struct {
		Bucket bucket `json:"bucket"`
	}
	table := settings.Table{"copy": {Shape: func() any { return new(shape) }, Secrets: []string{"bucket.secret_key"}}}
	set := settings.New(st, sealer, slog.Default(), table)
	if err := set.Set(ctx, "copy", json.RawMessage(`{"bucket":{"name":"b","secret_key":"hunter2"}}`), "test"); err != nil {
		t.Fatal(err)
	}
	var row core.Setting
	if err := st.Get(ctx, &row, store.Eq("name", "copy")); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(row.Value), "hunter2") {
		t.Fatalf("the nested secret is stored in the clear: %s", row.Value)
	}
	listed, err := set.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := json.Marshal(listed["copy"]); !strings.Contains(string(got), `"secret_key":"********"`) {
		t.Fatalf("the nested secret is listed as %s, want it masked", got)
	}
	for _, sent := range []string{`{"bucket":{"name":"c","secret_key":"********"}}`, `{"bucket":{"name":"c"}}`} {
		if err := set.Set(ctx, "copy", json.RawMessage(sent), "test"); err != nil {
			t.Fatal(err)
		}
		var got shape
		if err := settings.New(st, sealer, slog.Default(), table).Checked(ctx, "copy", &got); err != nil || got.Bucket.SecretKey != "hunter2" {
			t.Fatalf("after %s the secret reads %q (%v), want it kept", sent, got.Bucket.SecretKey, err)
		}
	}
}

// TestASecretSpelledInAnotherCaseIsNeverInTheClear: JSON field names match
// a setting's shape in any letter case, but secrets are found by their
// exact names. A value that names a field in another case is refused when
// stored; set by the environment, it is listed with its secrets masked.
func TestASecretSpelledInAnotherCaseIsNeverInTheClear(t *testing.T) {
	ctx := context.Background()
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	type bucket struct {
		SecretKey string `json:"secret_key"`
	}
	type shape struct {
		Bucket bucket `json:"bucket"`
	}
	table := settings.Table{"copy": {Shape: func() any { return new(shape) }, Secrets: []string{"bucket.secret_key"}}}
	for _, value := range []string{`{"bucket":{"SECRET_KEY":"hunter2"}}`, `{"Bucket":{"secret_key":"hunter2"}}`} {
		t.Run("stored "+value, func(t *testing.T) {
			st := testdb.SQLite(t)
			if err := settings.New(st, sealer, slog.Default(), table).Set(ctx, "copy", json.RawMessage(value), "test"); err == nil {
				t.Fatal("a value with a field spelled in another case was stored")
			}
		})
		t.Run("from the environment "+value, func(t *testing.T) {
			t.Setenv(settings.EnvName("copy"), value)
			listed, err := settings.New(testdb.SQLite(t), sealer, slog.Default(), table).List(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if got, _ := json.Marshal(listed["copy"]); strings.Contains(string(got), "hunter2") {
				t.Fatalf("the secret is listed in the clear: %s", got)
			}
		})
	}
}

// TestAnInternalSettingIsTheServersOwn: a setting the server keeps for
// itself is not listed, not set through Set (the admin area's way), and
// not taken from the environment; SetIn writes it, inside the caller's
// transaction, so it is there only if that commits.
func TestAnInternalSettingIsTheServersOwn(t *testing.T) {
	ctx := context.Background()
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	st := testdb.SQLite(t)
	table := settings.Table{
		"install.local_owner": {Shape: func() any { return new(string) }, Internal: true},
		"install.name":        {Shape: func() any { return new(string) }},
	}
	set := settings.New(st, sealer, slog.Default(), table)

	if err := set.Set(ctx, "install.local_owner", json.RawMessage(`"someone"`), ""); err == nil {
		t.Fatal("Set wrote a setting the server keeps for itself")
	}
	t.Setenv(settings.EnvName("install.local_owner"), "from-the-environment")
	var got string
	if err := set.Checked(ctx, "install.local_owner", &got); err != nil || got != "" {
		t.Fatalf("the environment set it: %q (%v)", got, err)
	}

	failed := st.Atomic(ctx, func(db store.DB) error {
		if err := set.SetIn(ctx, db, "install.local_owner", json.RawMessage(`"lost"`), ""); err != nil {
			return err
		}
		return context.Canceled // the rest of the transaction fails
	})
	if failed == nil {
		t.Fatal("the transaction did not fail")
	}
	if err := set.Checked(ctx, "install.local_owner", &got); err != nil || got != "" {
		t.Fatalf("a write in a transaction that failed is there: %q (%v)", got, err)
	}

	if err := st.Atomic(ctx, func(db store.DB) error {
		return set.SetIn(ctx, db, "install.local_owner", json.RawMessage(`"owner-id"`), "")
	}); err != nil {
		t.Fatal(err)
	}
	if err := set.Checked(ctx, "install.local_owner", &got); err != nil || got != "owner-id" {
		t.Fatalf("after the transaction: %q (%v)", got, err)
	}
	all, err := set.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, listed := all["install.local_owner"]; listed || len(all) != 1 {
		t.Fatalf("List gives %v, want only install.name", all)
	}
}
