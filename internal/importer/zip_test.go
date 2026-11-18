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
		if err := unzip(src, dst, exportLimits); err != nil {
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
		err := unzip(src, dst, exportLimits)
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
		if err := unzip(src, dst, exportLimits); err != nil {
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
		if err := unzip(writeZip(t, nil), dst, exportLimits); err != nil {
			t.Fatal(err)
		}
		if entries, err := os.ReadDir(dst); err != nil || len(entries) != 0 {
			t.Fatalf("%v, %v", entries, err)
		}
	})
	t.Run("a file that is not a zip", func(t *testing.T) {
		src := writeFile(t, "export.zip", "not a zip")
		if err := unzip(src, t.TempDir(), exportLimits); err == nil || !strings.Contains(err.Error(), "is not a zip file") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a folder that cannot be made is an error", func(t *testing.T) {
		dst := t.TempDir()
		if err := os.WriteFile(filepath.Join(dst, "sub"), []byte("a file where the folder goes"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := unzip(writeZip(t, map[string][]byte{"sub/": nil}), dst, exportLimits); err == nil {
			t.Fatal("no error when a folder of the zip could not be made")
		}
	})
}

// TestUnzipStaysWithinItsLimits: an export that would unpack to more than
// its limits allow (one file too large, too much in all, too many files,
// zips nested too deep) is refused whole, never cut short.
func TestUnzipStaysWithinItsLimits(t *testing.T) {
	small := unzipLimits{fileBytes: 1000, totalBytes: 25, files: 4, depth: 2}
	// roomy has room in bytes for a few small zips, and holds to the rest.
	roomy := unzipLimits{fileBytes: 1000, totalBytes: 5000, files: 4, depth: 2}
	refused := func(t *testing.T, limits unzipLimits, entries map[string][]byte, want string) {
		t.Helper()
		err := unzip(writeZip(t, entries), t.TempDir(), limits)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want one that says %q", err, want)
		}
	}
	t.Run("within them, everything is unpacked", func(t *testing.T) {
		dst := t.TempDir()
		inner := zipOf(t, map[string][]byte{"c.md": []byte("0123456789")})
		exact := unzipLimits{fileBytes: 1000, totalBytes: 20 + int64(len(inner)), files: 3, depth: 2}
		if err := unzip(writeZip(t, map[string][]byte{"a.md": []byte("0123456789"), "b.zip": inner}), dst, exact); err != nil {
			t.Fatal(err)
		}
		if got, err := os.ReadFile(filepath.Join(dst, "b", "c.md")); err != nil || string(got) != "0123456789" {
			t.Fatalf("%q, %v", got, err)
		}
	})
	t.Run("a file over the limit is refused, not cut short", func(t *testing.T) {
		dst := t.TempDir()
		err := unzip(writeZip(t, map[string][]byte{"big.md": bytes.Repeat([]byte("x"), 1001)}), dst, unzipLimits{fileBytes: 1000, totalBytes: 5000, files: 4, depth: 1})
		if err == nil || !strings.Contains(err.Error(), "big.md") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("files over the limit in all are refused", func(t *testing.T) {
		refused(t, small, map[string][]byte{"a.md": []byte("0123456789"), "b.md": []byte("0123456789"), "c.md": []byte("0123456789")}, "more than")
	})
	t.Run("the zips inside count toward the limit in all", func(t *testing.T) {
		inner := zipOf(t, map[string][]byte{"c.md": []byte("0123456789"), "d.md": []byte("0123456789")})
		refused(t, small, map[string][]byte{"a.md": []byte("0123456789"), "b.zip": inner}, "more than")
	})
	t.Run("too many files are refused", func(t *testing.T) {
		refused(t, small, map[string][]byte{"a": nil, "b": nil, "c": nil, "d": nil, "e": nil}, "files")
	})
	t.Run("folders count as files", func(t *testing.T) {
		refused(t, small, map[string][]byte{"a/": nil, "b/": nil, "c/": nil, "d/": nil, "e/": nil}, "files")
	})
	t.Run("the zips inside count as files", func(t *testing.T) {
		inner := zipOf(t, map[string][]byte{"c": nil, "d": nil, "e": nil}) // five with the zip and a
		refused(t, roomy, map[string][]byte{"a": nil, "b.zip": inner}, "files")
	})
	t.Run("the zips inside count toward the limit in all themselves", func(t *testing.T) {
		var buf bytes.Buffer
		w := zip.NewWriter(&buf)
		if _, err := w.Create("c.md"); err != nil {
			t.Fatal(err)
		}
		if err := w.SetComment(strings.Repeat("padding ", 100)); err != nil {
			t.Fatal(err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		refused(t, unzipLimits{fileBytes: 1000, totalBytes: 400, files: 4, depth: 2}, map[string][]byte{"b.zip": buf.Bytes()}, "more than")
	})
	t.Run("zips nested too deep are refused", func(t *testing.T) {
		deepest := zipOf(t, map[string][]byte{"x.md": []byte("x")})
		middle := zipOf(t, map[string][]byte{"c.zip": deepest})
		refused(t, roomy, map[string][]byte{"b.zip": middle}, "nested")
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
