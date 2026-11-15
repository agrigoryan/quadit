// Unpacking the zips that exports arrive in.

package importer

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// unzippedLimit is the most of one file unpacked from a zip.
const unzippedLimit = 2 << 30

// unzip unpacks src into the folder dst, and any zip inside it beside
// itself.
func unzip(src, dst string) (err error) {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return fmt.Errorf("%s is not a zip file: %w", src, err)
	}
	defer func() {
		if closeErr := zr.Close(); err == nil {
			err = closeErr
		}
	}()
	for _, f := range zr.File {
		p := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			return fmt.Errorf("the zip holds a path that climbs out of it: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(p, 0o750); err != nil {
				return err
			}
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

// unzipOne unpacks one file of a zip to the path to, making its folder.
func unzipOne(f *zip.File, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o750); err != nil {
		return err
	}
	in, err := f.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, io.LimitReader(in, unzippedLimit)); err != nil {
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
