// The cloud stores through gocloud.dev, the Config that picks one, and
// Layered and Move for going from one store to another.

package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	gcblob "gocloud.dev/blob"
	"gocloud.dev/gcerrors"
)

// Config says where files are kept. It is the "files" setting of the
// admin area.
type Config struct {
	// Kind is disk (default), s3 (AWS S3, Cloudflare R2, MinIO and anything
	// else that speaks S3), gcs (Google Cloud Storage) or azure (Azure Blob).
	Kind   string `json:"kind"`
	Bucket string `json:"bucket"` // the bucket, or the Azure container
	Prefix string `json:"prefix"` // a folder inside it, optional

	// s3
	Region    string `json:"region"`
	Endpoint  string `json:"endpoint"` // for R2, MinIO and others; empty for AWS
	AccessKey string `json:"access_key"`
	SecretKey string `json:"secret_key"`
	PathStyle bool   `json:"path_style"`

	// gcs: a service account key as JSON; empty uses the machine's identity
	Credentials string `json:"credentials"`

	// azure
	Account    string `json:"account"`
	AccountKey string `json:"account_key"`
}

// Kinds lists the kinds of file store.
var Kinds = []string{"disk", "s3", "gcs", "azure"}

// Open returns the file store a Config describes. Disk keeps files under
// dataDir/files; each cloud kind is opened in its own file.
func Open(ctx context.Context, c Config, dataDir string) (Store, error) {
	var b *gcblob.Bucket
	var err error
	switch c.Kind {
	case "", "disk":
		return NewDisk(filepath.Join(dataDir, "files"))
	case "s3":
		b, err = openS3(ctx, c)
	case "gcs":
		b, err = openGCS(ctx, c)
	case "azure":
		b, err = openAzure(ctx, c)
	default:
		return nil, fmt.Errorf("file storage: unknown kind %q; kinds are: %s", c.Kind, strings.Join(Kinds, ", "))
	}
	if err != nil {
		return nil, err
	}
	prefix := strings.Trim(c.Prefix, "/")
	if prefix != "" {
		prefix += "/"
	}
	return &cloud{b: b, kind: c.Kind, prefix: prefix}, nil
}

// need says that a kind of store cannot be opened without a setting.
func (c Config) need(what, v string) error {
	if v == "" {
		return fmt.Errorf("file storage: %s needs %s", c.Kind, what)
	}
	return nil
}

// orDefault is v, or def when v is empty.
func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// cloud is a bucket in a cloud store.
type cloud struct {
	b      *gcblob.Bucket
	kind   string
	prefix string
}

// FromBucket wraps an open bucket. Tests use it with an in-memory bucket.
func FromBucket(b *gcblob.Bucket, kind, prefix string) Store {
	return &cloud{b: b, kind: kind, prefix: prefix}
}

// Kind names the cloud: s3, gcs or azure.
func (c *cloud) Kind() string { return c.kind }

// Check lists one key of the bucket: the bucket is there and the
// credentials may read it.
func (c *cloud) Check(ctx context.Context) error {
	there, err := c.b.IsAccessible(ctx)
	if err != nil {
		return err
	}
	if !there {
		return fmt.Errorf("blob: the %s bucket is not there", c.kind)
	}
	return nil
}

// Put writes everything read from r under key.
func (c *cloud) Put(ctx context.Context, key string, r io.Reader, contentType string) error {
	w, err := c.b.NewWriter(ctx, c.prefix+key, &gcblob.WriterOptions{ContentType: contentType})
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, r); err != nil {
		return errors.Join(err, w.Close())
	}
	return w.Close()
}

// Open reads key, with the time it was last written.
func (c *cloud) Open(ctx context.Context, key string) (io.ReadSeekCloser, time.Time, error) {
	// The reader outlives this call, so it must not die with the request
	// that opened it being a little slow: the caller closes it.
	r, err := c.b.NewReader(ctx, c.prefix+key, nil)
	if err != nil {
		if gcerrors.Code(err) == gcerrors.NotFound {
			return nil, time.Time{}, ErrNotFound
		}
		return nil, time.Time{}, err
	}
	return r, r.ModTime(), nil
}

// Delete removes key; a key that holds nothing is not an error.
func (c *cloud) Delete(ctx context.Context, key string) error {
	if err := c.b.Delete(ctx, c.prefix+key); err != nil && gcerrors.Code(err) != gcerrors.NotFound {
		return err
	}
	return nil
}

// List calls each with every key under prefix, and its size.
func (c *cloud) List(ctx context.Context, prefix string, each func(string, int64) error) error {
	it := c.b.List(&gcblob.ListOptions{Prefix: c.prefix + prefix})
	for {
		obj, err := it.Next(ctx)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if obj.IsDir {
			continue
		}
		if err := each(strings.TrimPrefix(obj.Key, c.prefix), obj.Size); err != nil {
			return err
		}
	}
}

// Layered reads from the first store that has a key and writes to the
// first. It is how an install moves from disk to a cloud store without a
// gap: new files go to the cloud, old ones are still found on disk until
// they are copied over.
type Layered struct {
	Primary Store
	Old     Store
}

// Kind is the kind of the store written to.
func (l Layered) Kind() string { return l.Primary.Kind() }

// Check checks the store written to; the old one is only read from.
func (l Layered) Check(ctx context.Context) error { return l.Primary.Check(ctx) }

// Put writes to the primary store.
func (l Layered) Put(ctx context.Context, key string, r io.Reader, ct string) error {
	return l.Primary.Put(ctx, key, r, ct)
}

// Open reads from the primary store, or from the old one when the primary
// has nothing under key.
func (l Layered) Open(ctx context.Context, key string) (io.ReadSeekCloser, time.Time, error) {
	r, t, err := l.Primary.Open(ctx, key)
	if errors.Is(err, ErrNotFound) {
		return l.Old.Open(ctx, key)
	}
	return r, t, err
}

// Delete removes key from both stores.
func (l Layered) Delete(ctx context.Context, key string) error {
	return errors.Join(l.Primary.Delete(ctx, key), l.Old.Delete(ctx, key))
}

// List lists the keys of both stores, each once.
func (l Layered) List(ctx context.Context, prefix string, each func(string, int64) error) error {
	seen := map[string]bool{}
	if err := l.Primary.List(ctx, prefix, func(k string, n int64) error { seen[k] = true; return each(k, n) }); err != nil {
		return err
	}
	return l.Old.List(ctx, prefix, func(k string, n int64) error {
		if seen[k] {
			return nil
		}
		return each(k, n)
	})
}

// Unusable stands in for a file store that is set but cannot be used: it
// could not be opened, or refused a test write. Every call answers why, so
// that meanwhile nothing is written to, or looked for in, another store.
type Unusable struct {
	Set string // the kind of store that is set: s3, gcs or azure
	Err error  // why it cannot be used
}

func (u Unusable) why() error {
	return fmt.Errorf("the %s store cannot be used: %w", u.Set, u.Err)
}

// Kind is the kind of store that is set.
func (u Unusable) Kind() string { return u.Set }

// Check says why the store cannot be used.
func (u Unusable) Check(context.Context) error { return u.why() }

// Put stores nothing, and says why.
func (u Unusable) Put(context.Context, string, io.Reader, string) error { return u.why() }

// Delete removes nothing, and says why.
func (u Unusable) Delete(context.Context, string) error { return u.why() }

// List lists nothing, and says why.
func (u Unusable) List(context.Context, string, func(string, int64) error) error {
	return u.why()
}

// Open reads nothing, and says why.
func (u Unusable) Open(context.Context, string) (io.ReadSeekCloser, time.Time, error) {
	return nil, time.Time{}, u.why()
}

// Move copies everything from one store to another and removes it from the
// first once it is safely there. It returns how many files it moved.
func Move(ctx context.Context, from, to Store) (int, error) {
	var keys []string
	if err := from.List(ctx, "", func(k string, _ int64) error { keys = append(keys, k); return nil }); err != nil {
		return 0, err
	}
	moved := 0
	for _, k := range keys {
		r, _, err := from.Open(ctx, k)
		if err != nil {
			return moved, err
		}
		err = to.Put(ctx, k, r, "")
		r.Close()
		if err != nil {
			return moved, fmt.Errorf("copy %s: %w", k, err)
		}
		check, _, err := to.Open(ctx, k)
		if err != nil {
			return moved, fmt.Errorf("check %s: %w", k, err)
		}
		check.Close()
		if err := from.Delete(ctx, k); err != nil {
			return moved, err
		}
		moved++
	}
	return moved, nil
}
