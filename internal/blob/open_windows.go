package blob

import (
	"os"

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
