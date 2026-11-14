package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sort"
	"strings"
	"testing"

	"gocloud.dev/blob/memblob"
)

// every store must behave the same: this runs once per kind.
func testStore(t *testing.T, s Store) {
	ctx := context.Background()
	data := bytes.Repeat([]byte("0123456789"), 1000)
	if err := s.Put(ctx, "ws/file-1", bytes.NewReader(data), "text/plain"); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, "ws/file-2.preview", strings.NewReader("small"), ""); err != nil {
		t.Fatal(err)
	}
	r, _, err := s.Open(ctx, "ws/file-1")
	if err != nil {
		t.Fatal(err)
	}
	// Ranges: seek into the middle and read a slice, as a video player does.
	if _, err := r.Seek(5005, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	part := make([]byte, 10)
	if _, err := io.ReadFull(r, part); err != nil || string(part) != "5678901234" {
		t.Fatalf("range read = %q, %v", part, err)
	}
	if end, err := r.Seek(0, io.SeekEnd); err != nil || end != int64(len(data)) {
		t.Fatalf("size by seek = %d, %v", end, err)
	}
	r.Close()
	if _, _, err := s.Open(ctx, "ws/missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing key: %v", err)
	}
	var keys []string
	if err := s.List(ctx, "ws/", func(k string, n int64) error { keys = append(keys, k); return nil }); err != nil {
		t.Fatal(err)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "ws/file-1,ws/file-2.preview" {
		t.Fatalf("list = %v", keys)
	}
	if err := s.Delete(ctx, "ws/file-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "ws/file-1"); err != nil {
		t.Fatalf("deleting twice: %v", err)
	}
	if _, _, err := s.Open(ctx, "ws/file-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted key: %v", err)
	}
}

func TestDisk(t *testing.T) {
	d, err := NewDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	testStore(t, d)
	if err := d.Put(context.Background(), "../escape", strings.NewReader("x"), ""); err == nil {
		t.Fatal("a key that climbs out of the store was accepted")
	}
}

func TestCloudBucket(t *testing.T) {
	b := memblob.OpenBucket(nil)
	defer b.Close()
	testStore(t, FromBucket(b, "s3", "quadit/"))
}

func TestMoveAndLayers(t *testing.T) {
	ctx := context.Background()
	disk, _ := NewDisk(t.TempDir())
	b := memblob.OpenBucket(nil)
	defer b.Close()
	cloud := FromBucket(b, "s3", "")
	disk.Put(ctx, "ws/old", strings.NewReader("old file"), "")
	both := Layered{Primary: cloud, Old: disk}
	both.Put(ctx, "ws/new", strings.NewReader("new file"), "")
	// Old files are still found before they are moved.
	r, _, err := both.Open(ctx, "ws/old")
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	if n, err := Move(ctx, disk, cloud); err != nil || n != 1 {
		t.Fatalf("move = %d, %v", n, err)
	}
	if _, _, err := disk.Open(ctx, "ws/old"); !errors.Is(err, ErrNotFound) {
		t.Fatal("the moved file is still on disk")
	}
	r, _, err = cloud.Open(ctx, "ws/old")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(r)
	r.Close()
	if string(got) != "old file" {
		t.Fatalf("moved content = %q", got)
	}
}
