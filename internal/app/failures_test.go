package app

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// stdoutOf runs fn with standard output caught, and gives what it printed.
func stdoutOf(t *testing.T, fn func()) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stdout")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	was := os.Stdout
	os.Stdout = f
	fn()
	os.Stdout = was
	f.Close()
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// setUpInstall makes an install with one person, t@example.com, and gives
// its data directory.
func setUpInstall(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	var code int
	stdoutOf(t, func() {
		code = Admin([]string{"setup", "--data", dir, "--name", "T O", "--email", "t@example.com", "--password", "a long password", "--workspace", "test"}, "test")
	})
	if code != 0 {
		t.Fatalf("setup: exit %d", code)
	}
	return dir
}

// refuseUserUpdates makes every change to the users table fail, as a
// database that refuses a write would.
func refuseUserUpdates(t *testing.T, dir string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "quadit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(context.Background(), `CREATE TRIGGER refuse_user_updates BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`); err != nil {
		t.Fatal(err)
	}
}

func TestAdminSaysWhenItsWriteFails(t *testing.T) {
	for _, tc := range []struct {
		command string
		success string // what it prints when it worked
	}{
		{"reset-password", "new password for"},
		{"make-admin", "can now run the install"},
	} {
		t.Run(tc.command, func(t *testing.T) {
			dir := setUpInstall(t)
			refuseUserUpdates(t, dir)
			var code int
			out := stdoutOf(t, func() { code = Admin([]string{tc.command, "--data", dir, "t@example.com"}, "test") })
			if code == 0 {
				t.Fatalf("exit 0 when the write failed; printed %q", out)
			}
			if strings.Contains(out, tc.success) {
				t.Fatalf("printed success when the write failed: %q", out)
			}
		})
	}
}

func TestABrokenFilesSettingIsAnError(t *testing.T) {
	dir := setUpInstall(t)
	o := Options{Data: dir}
	st, sealer, err := o.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	t.Setenv("QUADIT_SETTING_FILES", `{"kind": "s3",`)
	if _, err := OpenFiles(context.Background(), st, sealer, dir); err == nil {
		t.Fatal("a files setting that is not JSON was taken as the local disk")
	}
}

func TestASecretThatCannotBeReadIsNotReplaced(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("file modes do not keep this user from reading")
	}
	t.Setenv("QUADIT_SECRET", "")
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.key")
	secret := []byte("the install's own secret, 32 bytes")
	if err := os.WriteFile(path, secret, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o200); err != nil { // writable, not readable
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	o := Options{Data: dir}
	if _, err := o.secret(); err == nil {
		t.Fatal("no error for a secret that cannot be read")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(secret) {
		t.Fatalf("the secret was replaced: %q, %v", got, err)
	}
}
