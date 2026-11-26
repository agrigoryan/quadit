package blob

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// OpenFile opens the file at path for reading. Meanwhile others may remove
// it or put another file in its place, and this reader goes on reading the
// one it opened. Windows refuses both while a file is open, unless it was
// opened sharing them, which os.Open does not do.
func OpenFile(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	const shared = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
	h, err := windows.CreateFile(name, windows.GENERIC_READ, shared, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// Replace moves the file at from to the path to, beside it, in one step:
// whatever was at to is replaced, even while it is being read (opened with
// OpenFile), and its readers read on what they opened. A plain rename on
// Windows refuses to replace a file that is open; a rename within the
// folder opened as an os.Root replaces it as on Unix.
func Replace(from, to string) error {
	dir := filepath.Dir(to)
	if filepath.Dir(from) != dir {
		return fmt.Errorf("blob: %s is not beside %s", from, to)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }() // a folder opened to rename in: nothing was written through it
	return root.Rename(filepath.Base(from), filepath.Base(to))
}
