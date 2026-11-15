package importer

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// unzip unpacks src into the folder dst, and any zip inside it beside
// itself.
func unzip(src, dst string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return fmt.Errorf("%s is not a zip file: %w", src, err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		p := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			return fmt.Errorf("the zip holds a path that climbs out of it: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o750)
			continue
		}
		if err := unzipOne(f, p); err != nil {
			return err
		}
		// A Notion export nests one zip inside another.
		if strings.HasSuffix(strings.ToLower(p), ".zip") {
			if err := unzip(p, strings.TrimSuffix(p, filepath.Ext(p))); err != nil {
				return err
			}
			os.Remove(p)
		}
	}
	return nil
}

func unzipOne(f *zip.File, to string) error {
	os.MkdirAll(filepath.Dir(to), 0o750)
	in, err := f.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, io.LimitReader(in, 2<<30)); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// unzipToTemp unpacks a zip into a new temporary folder.
func unzipToTemp(src, name string) (string, error) {
	dir, err := os.MkdirTemp("", "quadit-"+name+"-*")
	if err != nil {
		return "", err
	}
	if err := unzip(src, dir); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}
