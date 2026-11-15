package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestStaysInside: sync touches only real files and folders of a checkout,
// never anything reached through a link, wherever the link points.
func TestStaysInside(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(dir, "docs", "real"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "docs", "real", "deep.md"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(outside, "secret.md"), []byte("x"), 0o644))
	must(os.Symlink("real", filepath.Join(dir, "docs", "inl")))                                 // a folder inside, by a link
	must(os.Symlink(outside, filepath.Join(dir, "docs", "out")))                                // a folder outside
	must(os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(dir, "docs", "key.md"))) // a file outside
	must(os.Symlink("real/deep.md", filepath.Join(dir, "docs", "alias.md")))                    // a file inside
	must(os.Symlink(filepath.Join(dir, "nowhere"), filepath.Join(dir, "docs", "dangling.md")))  // points at nothing
	for path, want := range map[string]bool{
		"docs":                    true,
		"docs/real":               true,
		"docs/real/deep.md":       true,
		"docs/real/new.md":        true, // not there yet
		"docs/new/folder/page.md": true, // nor its folders
		"docs/inl":                false,
		"docs/inl/deep.md":        false, // would overwrite real/deep.md
		"docs/inl/new.md":         false, // would land in real/
		"docs/out":                false,
		"docs/out/secret.md":      false,
		"docs/out/new.md":         false,
		"docs/key.md":             false,
		"docs/alias.md":           false,
		"docs/dangling.md":        false,
		"../elsewhere":            false,
		"docs/../../elsewhere":    false,
	} {
		if got := staysInside(dir, filepath.Join(dir, filepath.FromSlash(path))); got != want {
			t.Errorf("staysInside(%s) = %v, want %v", path, got, want)
		}
	}
}
