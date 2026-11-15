package importer

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// zipOf makes a zip of the given entries, by name; a name ending in / is a
// folder.
func zipOf(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range entries {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// writeZip writes a zip of entries to a new file and gives its path.
func writeZip(t *testing.T, entries map[string][]byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "export.zip")
	if err := os.WriteFile(path, zipOf(t, entries), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUnzip(t *testing.T) {
	t.Run("files and folders", func(t *testing.T) {
		dst := t.TempDir()
		src := writeZip(t, map[string][]byte{"a.md": []byte("A"), "sub/": nil, "sub/b.md": []byte("B")})
		if err := unzip(src, dst); err != nil {
			t.Fatal(err)
		}
		for name, want := range map[string]string{"a.md": "A", "sub/b.md": "B"} {
			got, err := os.ReadFile(filepath.Join(dst, name))
			if err != nil || string(got) != want {
				t.Errorf("%s: %q, %v", name, got, err)
			}
		}
	})
	t.Run("a path that climbs out is refused", func(t *testing.T) {
		parent := t.TempDir()
		dst := filepath.Join(parent, "in")
		src := writeZip(t, map[string][]byte{"../out.md": []byte("escaped")})
		err := unzip(src, dst)
		if err == nil || !strings.Contains(err.Error(), "climbs out") {
			t.Fatalf("err = %v", err)
		}
		if _, err := os.Stat(filepath.Join(parent, "out.md")); !os.IsNotExist(err) {
			t.Fatal("the file was written outside the folder")
		}
	})
	t.Run("a zip inside is unpacked beside itself", func(t *testing.T) {
		dst := t.TempDir()
		inner := zipOf(t, map[string][]byte{"page.md": []byte("inner")})
		src := writeZip(t, map[string][]byte{"part/Export-1.zip": inner})
		if err := unzip(src, dst); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(dst, "part", "Export-1", "page.md"))
		if err != nil || string(got) != "inner" {
			t.Fatalf("%q, %v", got, err)
		}
		if _, err := os.Stat(filepath.Join(dst, "part", "Export-1.zip")); !os.IsNotExist(err) {
			t.Fatal("the inner zip was left behind")
		}
	})
	t.Run("an empty archive", func(t *testing.T) {
		dst := t.TempDir()
		if err := unzip(writeZip(t, nil), dst); err != nil {
			t.Fatal(err)
		}
		if entries, err := os.ReadDir(dst); err != nil || len(entries) != 0 {
			t.Fatalf("%v, %v", entries, err)
		}
	})
	t.Run("a file that is not a zip", func(t *testing.T) {
		src := writeFile(t, "export.zip", "not a zip")
		if err := unzip(src, t.TempDir()); err == nil || !strings.Contains(err.Error(), "is not a zip file") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a folder that cannot be made is an error", func(t *testing.T) {
		dst := t.TempDir()
		if err := os.WriteFile(filepath.Join(dst, "sub"), []byte("a file where the folder goes"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := unzip(writeZip(t, map[string][]byte{"sub/": nil}), dst); err == nil {
			t.Fatal("no error when a folder of the zip could not be made")
		}
	})
}

func TestUnzipToTempLeavesNothingWhenItFails(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	if _, err := unzipToTemp(writeZip(t, map[string][]byte{"../x": nil}), "test"); err == nil {
		t.Fatal("no error")
	}
	if entries, err := os.ReadDir(tmp); err != nil || len(entries) != 0 {
		t.Fatalf("left behind: %v, %v", entries, err)
	}
}
