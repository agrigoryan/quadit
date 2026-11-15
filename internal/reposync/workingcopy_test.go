package reposync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadFolder: the Markdown files under the folder are its pages; every
// other thing there that a page's file could be written over is taken.
func TestReadFolder(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	docs := filepath.Join(dir, "docs")
	must(os.MkdirAll(filepath.Join(docs, "sub", "yy.md"), 0o755))
	must(os.MkdirAll(filepath.Join(docs, ".hidden"), 0o755))
	must(os.WriteFile(filepath.Join(docs, "a.md"), []byte("A.\n"), 0o644))
	must(os.WriteFile(filepath.Join(docs, "empty.md"), nil, 0o644))
	must(os.WriteFile(filepath.Join(docs, "sub", "b.MD"), []byte("B.\n"), 0o644))
	must(os.WriteFile(filepath.Join(docs, ".hidden", "c.md"), []byte("C.\n"), 0o644))
	must(os.WriteFile(filepath.Join(docs, "notes.txt"), []byte("text\n"), 0o644))
	must(os.WriteFile(filepath.Join(docs, "big.md"), []byte(strings.Repeat("x", maxPageFile)), 0o644))
	must(os.Symlink("a.md", filepath.Join(docs, "leak.md")))

	f, err := (&workingCopy{dir: dir, folder: "docs"}).read()
	if err != nil {
		t.Fatal(err)
	}
	if len(f.files) != 3 || f.files["a.md"] != "A.\n" || f.files["sub/b.MD"] != "B.\n" || f.files["empty.md"] != "" {
		t.Errorf("the pages' files: %q", f.files)
	}
	for _, p := range []string{"leak.md", "sub/yy.md", "big.md"} {
		if !f.taken[p] {
			t.Errorf("%s is not taken", p)
		}
	}
	if f.missing {
		t.Error("the folder is said to be missing")
	}
	if f, err := (&workingCopy{dir: dir, folder: "nowhere"}).read(); err != nil || !f.missing || len(f.files) != 0 {
		t.Errorf("a missing folder: %+v %v", f, err)
	}
}
