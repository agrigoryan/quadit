package settings_test

import (
	"context"
	"log/slog"
	"testing"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/settings"
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
