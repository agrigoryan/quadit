// A backup's file: its name, and its copies kept somewhere else.

package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
)

// NewFile makes the file of a backup taken at `at`, in dir, and opens it for
// writing. A backup's file is named for the second it was taken in
// (quadit-YYYYMMDD-HHMMSS.tar.gz, in UTC), so the names sort by age. When
// that name is taken — a second backup in the same second — the next free
// second names it: no backup ever writes over another.
func NewFile(dir string, at time.Time) (*os.File, error) {
	at = at.UTC()
	for range 3600 {
		path := filepath.Join(dir, at.Format(fileName))
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

// fileName is the layout of a backup's file name, for time.Format.
const fileName = "quadit-20060102-150405.tar.gz"

// IsFile reports whether name is exactly a name NewFile gives a backup's
// file. Backups are dropped by this test, in folders and buckets others may
// share, so a name that only looks like one (quadit-manual.tar.gz) is not.
func IsFile(name string) bool {
	at, err := time.Parse(fileName, name)
	return err == nil && at.Format(fileName) == name
}

// Copy puts a copy of the backup's file at path in a store, under dir (a
// key prefix: empty, or ending in "/"), named as the file is. It checks the
// store first, so that a folder which is gone (a drive not mounted) is
// reported, not made again on the disk the copy was meant to leave.
func Copy(ctx context.Context, path string, to blob.Store, dir string) error {
	if err := to.Check(ctx); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return to.Put(ctx, dir+filepath.Base(path), f, "application/gzip")
}

// DropOldCopies keeps the newest keep copies of backups in a store under
// dir and removes the others. Only backup files directly under dir count;
// anything else there is left alone.
func DropOldCopies(ctx context.Context, in blob.Store, dir string, keep int) error {
	var names []string
	err := in.List(ctx, dir, func(key string, _ int64) error {
		if name := strings.TrimPrefix(key, dir); IsFile(name) {
			names = append(names, name)
		}
		return nil
	})
	if err != nil {
		return err
	}
	slices.Sort(names)
	var failed []error
	for _, name := range names[:max(len(names)-keep, 0)] {
		if err := in.Delete(ctx, dir+name); err != nil {
			failed = append(failed, fmt.Errorf("%s: %w", name, err))
		}
	}
	return errors.Join(failed...)
}
