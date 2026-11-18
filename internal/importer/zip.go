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

// unzipLimits bound what one export unpacks to. Every entry of every zip
// in it counts: a folder and a nested zip are each one of the files, and a
// nested zip's own bytes count toward the total as well as what it holds,
// since both are on disk while it is unpacked. An export over any limit is
// refused whole: a file is never cut short to fit.
type unzipLimits struct {
	fileBytes  int64 // one file
	totalBytes int64 // every file
	files      int   // how many entries: files, folders and zips
	depth      int   // how many zips deep: 1 is the export alone
}

// exportLimits are the limits of every import: room for a large export,
// none for a zip made to unpack to far more than it is.
var exportLimits = unzipLimits{fileBytes: 2 << 30, totalBytes: 8 << 30, files: 200_000, depth: 3}

// unzip unpacks src into the folder dst, and any zip inside it beside
// itself, within limits.
func unzip(src, dst string, limits unzipLimits) error {
	u := &unzipping{limits: limits, bytesLeft: limits.totalBytes, filesLeft: limits.files}
	return u.unzip(src, dst, 1)
}

// unzipping is one run of unzip: its limits, and what is left of them.
type unzipping struct {
	limits    unzipLimits
	bytesLeft int64
	filesLeft int
}

// unzip unpacks one zip, depth zips deep.
func (u *unzipping) unzip(src, dst string, depth int) (err error) {
	if depth > u.limits.depth {
		return fmt.Errorf("the export holds zips nested more than %d deep", u.limits.depth)
	}
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
		if u.filesLeft--; u.filesLeft < 0 {
			return fmt.Errorf("the export holds more than %d files", u.limits.files)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(p, 0o750); err != nil {
				return err
			}
			continue
		}
		n, err := u.unzipOne(f, p, min(u.limits.fileBytes, u.bytesLeft))
		if err != nil {
			return err
		}
		u.bytesLeft -= n
		// A Notion export nests one zip inside another.
		if strings.HasSuffix(strings.ToLower(p), ".zip") {
			if err := u.unzip(p, strings.TrimSuffix(p, filepath.Ext(p)), depth+1); err != nil {
				return err
			}
			os.Remove(p)
		}
	}
	return nil
}

// unzipOne unpacks one file of a zip to the path to, making its folder,
// and gives its size. A file larger than room is refused: the bytes are
// counted as they are written, as the sizes a zip states can be false.
func (u *unzipping) unzipOne(f *zip.File, to string, room int64) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(to), 0o750); err != nil {
		return 0, err
	}
	in, err := f.Open()
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(in, room+1))
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	switch {
	case err != nil:
		return 0, err
	case n > u.limits.fileBytes:
		return 0, fmt.Errorf("%s unpacks to more than %d bytes, the most one file of an export may be", f.Name, u.limits.fileBytes)
	case n > room:
		return 0, fmt.Errorf("the export unpacks to more than %d bytes, the most an export may be", u.limits.totalBytes)
	}
	return n, nil
}

// unzipToTemp unpacks a zip into a new temporary folder.
func unzipToTemp(src, name string) (string, error) {
	dir, err := os.MkdirTemp("", "quadit-"+name+"-*")
	if err != nil {
		return "", err
	}
	if err := unzip(src, dir, exportLimits); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}
