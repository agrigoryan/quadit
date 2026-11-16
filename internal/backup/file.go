package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// NewFile makes the file of a backup taken at `at`, in dir, and opens it for
// writing. A backup's file is named for the second it was taken in
// (quadit-YYYYMMDD-HHMMSS.tar.gz, in UTC), so the names sort by age. When
// that name is taken — a second backup in the same second — the next free
// second names it: no backup ever writes over another.
func NewFile(dir string, at time.Time) (*os.File, error) {
	at = at.UTC()
	for range 3600 {
		path := filepath.Join(dir, "quadit-"+at.Format("20060102-150405")+".tar.gz")
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		at = at.Add(time.Second)
	}
	return nil, fmt.Errorf("no free name for a backup in %s", dir)
}
