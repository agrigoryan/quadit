// Package blob stores file contents. Local disk is the default; cloud
// stores implement the same interface.
//
//	blob.go          the Store interface, and Disk
//	cloud.go         the Config, the cloud stores, Layered and Move
//	cloud_<kind>.go  opening each cloud: s3, gcs, azure
package blob

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNotFound is returned for a key that holds nothing.
var ErrNotFound = errors.New("blob: not found")

// Store keeps bytes under keys. Keys use forward slashes.
type Store interface {
	// Put stores everything read from r under key, replacing what was there.
	Put(ctx context.Context, key string, r io.Reader, contentType string) error
	// Open returns a reader that can seek, so ranges can be served.
	Open(ctx context.Context, key string) (io.ReadSeekCloser, time.Time, error)
	Delete(ctx context.Context, key string) error
	// List calls each with every key under a prefix.
	List(ctx context.Context, prefix string, each func(key string, size int64) error) error
	// Kind names the store for the admin area: "disk", "s3", ...
	Kind() string
}

// Disk stores files under a directory.
type Disk struct{ Root string }

// NewDisk returns a store rooted at dir, creating it if needed.
func NewDisk(dir string) (*Disk, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &Disk{Root: dir}, nil
}

// Kind names the store for the admin area: "disk".
func (d *Disk) Kind() string { return "disk" }

// path is where key is kept; a key that climbs out of the root is refused.
func (d *Disk) path(key string) (string, error) {
	clean := filepath.Clean("/" + key)
	if strings.Contains(key, "..") || clean == "/" {
		return "", errors.New("blob: bad key")
	}
	return filepath.Join(d.Root, filepath.FromSlash(clean)), nil
}

// Put writes everything read from r under key, all at once: a reader
// never sees half a file.
func (d *Disk) Put(_ context.Context, key string, r io.Reader, _ string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		return err
	}
	// Write beside the target and rename, so a reader never sees half a file.
	tmp, err := os.CreateTemp(filepath.Dir(p), ".put-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// Open opens the file kept under key, with the time it was last written.
func (d *Disk) Open(_ context.Context, key string) (io.ReadSeekCloser, time.Time, error) {
	p, err := d.path(key)
	if err != nil {
		return nil, time.Time{}, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, time.Time{}, ErrNotFound
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, time.Time{}, err
	}
	return f, st.ModTime(), nil
}

// Delete removes key; a key that holds nothing is not an error.
func (d *Disk) Delete(_ context.Context, key string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// List calls each with every key under prefix, and its size, leaving out
// files being written.
func (d *Disk) List(_ context.Context, prefix string, each func(string, int64) error) error {
	return filepath.WalkDir(d.Root, func(p string, e os.DirEntry, err error) error {
		if err != nil || e.IsDir() || strings.HasPrefix(e.Name(), ".put-") {
			return err
		}
		rel, err := filepath.Rel(d.Root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		return each(key, info.Size())
	})
}
