// Package backup writes and reads the portable archive: every table as
// JSON lines plus every stored file, in one .tar.gz. The same archive is
// made on SQLite and on Postgres, on disk and on cloud storage, and can be
// restored onto any of them.
package backup

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/store"
)

// Entry is one member of the archive as the manifest records it.
type Entry struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Rows   int    `json:"rows,omitempty"`
}

// Manifest is the last member of an archive. It lists the others with
// their checksums, so an archive can be verified without restoring it.
type Manifest struct {
	Format    int     `json:"format"`
	CreatedAt int64   `json:"created_at"`
	Version   string  `json:"version"`
	Database  string  `json:"database"`
	Entries   []Entry `json:"entries"`
}

// skipPrefixes are stored objects that are not users' files.
var skipPrefixes = []string{"backups/", "probe/"}

// Write makes an archive of everything.
func Write(ctx context.Context, st store.Store, files blob.Store, version string, w io.Writer) (Manifest, error) {
	m := Manifest{Format: 1, CreatedAt: time.Now().UnixMilli(), Version: version, Database: st.Dialect()}
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	add := func(name string, size int64, r io.Reader, rows int) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Size: size, Mode: 0o600, ModTime: time.UnixMilli(m.CreatedAt)}); err != nil {
			return err
		}
		h := sha256.New()
		n, err := io.Copy(io.MultiWriter(tw, h), r)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if n != size {
			return fmt.Errorf("%s: changed size while it was read (%d, then %d)", name, size, n)
		}
		m.Entries = append(m.Entries, Entry{Name: name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil)), Rows: rows})
		return nil
	}
	// Tables first, in an order that can be loaded back.
	for _, t := range store.Tables() {
		tmp, err := os.CreateTemp("", "quadit-backup-*.jsonl")
		if err != nil {
			return m, err
		}
		bw := bufio.NewWriter(tmp)
		rows := 0
		err = st.Dump(ctx, t.Name, func(row map[string]any) error {
			raw, err := json.Marshal(row)
			if err != nil {
				return err
			}
			rows++
			bw.Write(raw)
			return bw.WriteByte('\n')
		})
		if err == nil {
			err = bw.Flush()
		}
		var size int64
		if err == nil {
			size, err = tmp.Seek(0, io.SeekCurrent)
		}
		if err == nil {
			_, err = tmp.Seek(0, io.SeekStart)
		}
		if err == nil {
			err = add("db/"+t.Name+".jsonl", size, tmp, rows)
		}
		tmp.Close()
		os.Remove(tmp.Name())
		if err != nil {
			return m, fmt.Errorf("table %s: %w", t.Name, err)
		}
	}
	type obj struct {
		key  string
		size int64
	}
	var objs []obj
	err := files.List(ctx, "", func(k string, n int64) error {
		for _, p := range skipPrefixes {
			if strings.HasPrefix(k, p) {
				return nil
			}
		}
		objs = append(objs, obj{k, n})
		return nil
	})
	if err != nil {
		return m, fmt.Errorf("listing files: %w", err)
	}
	for _, o := range objs {
		r, _, err := files.Open(ctx, o.key)
		if errors.Is(err, blob.ErrNotFound) {
			continue // deleted while the backup ran
		}
		if err != nil {
			return m, err
		}
		err = add("files/"+o.key, o.size, r, 0)
		r.Close()
		if err != nil {
			return m, err
		}
	}
	raw, _ := json.MarshalIndent(m, "", " ")
	if err := tw.WriteHeader(&tar.Header{Name: "manifest.json", Size: int64(len(raw)), Mode: 0o600, ModTime: time.UnixMilli(m.CreatedAt)}); err != nil {
		return m, err
	}
	if _, err := tw.Write(raw); err != nil {
		return m, err
	}
	if err := tw.Close(); err != nil {
		return m, err
	}
	return m, gz.Close()
}

// read walks an archive, handing each member to each. It returns the
// manifest, which comes last.
func read(r io.Reader, each func(name string, size int64, body io.Reader) error) (Manifest, error) {
	var m Manifest
	gz, err := gzip.NewReader(r)
	if err != nil {
		return m, fmt.Errorf("this is not a backup archive: %w", err)
	}
	tr := tar.NewReader(gz)
	found := false
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return m, fmt.Errorf("the archive is damaged: %w", err)
		}
		if h.Name == "manifest.json" {
			if err := json.NewDecoder(tr).Decode(&m); err != nil {
				return m, fmt.Errorf("the manifest is damaged: %w", err)
			}
			found = true
			continue
		}
		if err := each(h.Name, h.Size, tr); err != nil {
			return m, err
		}
	}
	if !found {
		return m, errors.New("the archive has no manifest: it is incomplete")
	}
	return m, nil
}

// Verify reads a whole archive and checks every member against the
// manifest's checksums.
func Verify(r io.Reader) (Manifest, error) {
	sums := map[string]Entry{}
	m, err := read(r, func(name string, size int64, body io.Reader) error {
		h := sha256.New()
		n, err := io.Copy(h, body)
		if err != nil {
			return err
		}
		sums[name] = Entry{Name: name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}
		return nil
	})
	if err != nil {
		return m, err
	}
	for _, e := range m.Entries {
		got, ok := sums[e.Name]
		if !ok {
			return m, fmt.Errorf("the archive is missing %s", e.Name)
		}
		if got.SHA256 != e.SHA256 || got.Size != e.Size {
			return m, fmt.Errorf("%s does not match its checksum: the archive is damaged", e.Name)
		}
	}
	if len(sums) != len(m.Entries) {
		return m, errors.New("the archive holds members its manifest does not list")
	}
	return m, nil
}

// selfRefs are the columns that point at another row of the same table.
// Rows are loaded parents first.
var selfRefs = map[string][]string{"users": {"responsible_id", "created_by"}, "tasks": {"parent_id"}, "docs": {"parent_id"}, "comments": {"parent_id"}}

func parentsFirst(rows []map[string]any, cols []string) []map[string]any {
	byID := map[string]map[string]any{}
	for _, r := range rows {
		if s, ok := r["id"].(string); ok {
			byID[s] = r
		}
	}
	var out []map[string]any
	done := map[string]bool{}
	var visit func(r map[string]any, depth int)
	visit = func(r map[string]any, depth int) {
		rid, _ := r["id"].(string)
		if done[rid] {
			return
		}
		done[rid] = true
		if depth < 200 {
			for _, c := range cols {
				if pid, _ := r[c].(string); pid != "" && pid != rid {
					if p, ok := byID[pid]; ok {
						visit(p, depth+1)
					}
				}
			}
		}
		out = append(out, r)
	}
	for _, r := range rows {
		visit(r, 0)
	}
	return out
}

func tableOf(name string) (string, bool) {
	if !strings.HasPrefix(name, "db/") || !strings.HasSuffix(name, ".jsonl") {
		return "", false
	}
	return strings.TrimSuffix(strings.TrimPrefix(name, "db/"), ".jsonl"), true
}

// lines reads JSON lines into rows, calling flush with each batch.
func lines(body io.Reader, batch int, flush func([]map[string]any) error) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 1<<20), 256<<20)
	var rows []map[string]any
	for sc.Scan() {
		var row map[string]any
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		if err := dec.Decode(&row); err != nil {
			return err
		}
		rows = append(rows, row)
		if batch > 0 && len(rows) >= batch {
			if err := flush(rows); err != nil {
				return err
			}
			rows = nil
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return flush(rows)
}

// Restore loads an archive into an empty database and file store.
func Restore(ctx context.Context, st store.Store, files blob.Store, r io.Reader) (Manifest, error) {
	if n, err := st.Count(ctx, "users"); err != nil {
		return Manifest{}, err
	} else if n > 0 {
		return Manifest{}, errors.New("this database already has data; a full restore goes into an empty one (to bring back one task or page, name it)")
	}
	return read(r, func(name string, size int64, body io.Reader) error {
		if key, ok := strings.CutPrefix(name, "files/"); ok {
			return files.Put(ctx, key, body, "")
		}
		table, ok := tableOf(name)
		if !ok {
			return nil
		}
		if _, known := store.TableNamed(table); !known {
			return nil // a table from a newer version: skip what this one cannot hold
		}
		batch := 500
		if _, self := selfRefs[table]; self {
			batch = 0 // all at once, to order parents first
		}
		return lines(body, batch, func(rows []map[string]any) error {
			if len(rows) == 0 {
				return nil
			}
			if cols, self := selfRefs[table]; self {
				rows = parentsFirst(rows, cols)
			}
			return st.Load(ctx, table, rows)
		})
	})
}

// Item names one task or page to bring back from an archive.
type Item struct {
	Workspace string // slug
	Kind      string // task or doc
	Ref       string // a task key or id, or a page id
}

// RestoreItem brings one task or page back from an archive into a database
// that has moved on: rows that are gone are put back, a row in the trash
// is taken out of it, and rows that are still there are left as they are.
// It returns the id of the task or page.
func RestoreItem(ctx context.Context, st store.Store, files blob.Store, r io.Reader, it Item) (string, error) {
	var wsID, rootID string
	decisions, keys := map[string]bool{}, map[string]bool{}
	pending := map[string]map[string]any{} // file rows seen, until we know which are wanted
	put := func(table string, row map[string]any, cond ...store.Cond) error {
		if n, err := st.Count(ctx, table, cond...); err != nil {
			return err
		} else if n > 0 {
			if table == "tasks" || table == "docs" {
				_, err := st.Update(ctx, table, map[string]any{"deleted_at": 0}, cond...)
				return err
			}
			return nil
		}
		return st.Load(ctx, table, []map[string]any{row})
	}
	str := func(row map[string]any, k string) string { s, _ := row[k].(string); return s }
	_, err := read(r, func(name string, size int64, body io.Reader) error {
		if key, ok := strings.CutPrefix(name, "files/"); ok {
			if keys[key] {
				return files.Put(ctx, key, body, "")
			}
			return nil
		}
		table, ok := tableOf(name)
		if !ok {
			return nil
		}
		return lines(body, 0, func(rows []map[string]any) error {
			if cols, self := selfRefs[table]; self {
				rows = parentsFirst(rows, cols)
			}
			for _, row := range rows {
				id := str(row, "id")
				var err error
				switch {
				case table == "workspaces" && str(row, "slug") == it.Workspace:
					wsID = id
				case wsID == "" || (str(row, "workspace_id") != wsID && table != "files"):
				case table == "tasks" && it.Kind == "task" && (strings.EqualFold(str(row, "key"), it.Ref) || id == it.Ref):
					rootID = id
					row["deleted_at"], row["deleted_by"] = nil, nil
					if str(row, "parent_id") != "" {
						if n, _ := st.Count(ctx, "tasks", store.Eq("id", str(row, "parent_id"))); n == 0 {
							row["parent_id"] = nil // its parent is gone for good
						}
					}
					err = put(table, row, store.Eq("id", id))
				case table == "docs" && it.Kind == "doc" && id == it.Ref:
					rootID = id
					row["deleted_at"] = nil
					if str(row, "parent_id") != "" {
						if n, _ := st.Count(ctx, "docs", store.Eq("id", str(row, "parent_id"))); n == 0 {
							row["parent_id"] = nil
						}
					}
					err = put(table, row, store.Eq("id", id))
				case rootID == "":
				case table == "task_labels" && str(row, "task_id") == rootID:
					err = put(table, row, store.Eq("task_id", rootID), store.Eq("label_id", str(row, "label_id")))
				case table == "decisions" && str(row, "task_id") == rootID:
					decisions[id] = true
					err = put(table, row, store.Eq("id", id))
				case table == "decision_options" && decisions[str(row, "decision_id")]:
					err = put(table, row, store.Eq("id", id))
				case (table == "comments" || table == "task_links") && (str(row, "task_id") == rootID || str(row, "doc_id") == rootID):
					err = put(table, row, store.Eq("id", id))
				case (table == "doc_blocks" || table == "doc_versions") && str(row, "doc_id") == rootID:
					err = put(table, row, store.Eq("id", id))
				case (table == "db_properties" || table == "db_views") && str(row, "database_id") == rootID:
					err = put(table, row, store.Eq("id", id))
				case table == "files":
					// Files come before attachments in the archive, so keep
					// them all in mind until we know which are wanted.
					pending[id] = row
				case table == "attachments" && (str(row, "task_id") == rootID || str(row, "subject_id") == rootID):
					if f, ok := pending[str(row, "file_id")]; ok {
						f["deleted_at"] = nil
						if err = put("files", f, store.Eq("id", str(row, "file_id"))); err == nil {
							keys[str(f, "storage_key")] = true
							if pk := str(f, "preview_key"); pk != "" {
								keys[pk] = true
							}
						}
					}
					if err == nil {
						err = put(table, row, store.Eq("id", id))
					}
				}
				if err != nil {
					return fmt.Errorf("%s: %w", table, err)
				}
			}
			return nil
		})
	})
	if err != nil {
		return "", err
	}
	if wsID == "" {
		return "", fmt.Errorf("the archive has no workspace %q", it.Workspace)
	}
	if rootID == "" {
		return "", fmt.Errorf("the archive has no %s %q in %s", it.Kind, it.Ref, it.Workspace)
	}
	return rootID, nil
}
