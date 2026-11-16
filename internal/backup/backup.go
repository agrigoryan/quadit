// Package backup writes and reads the portable archive: every table as
// JSON lines plus every stored file, in one .tar.gz. The same archive is
// made on SQLite and on Postgres, on disk and on cloud storage, and can be
// restored onto any of them.
//
// The archive's first member (schema.json) says the schema version it was
// made at and the Quadit that made it, so a restore can refuse an archive
// it cannot read whole before it writes anything; its last (manifest.json)
// lists every member with its checksum. An archive made before the first
// member existed has only the last.
package backup

import (
	"archive/tar"
	"bufio"
	"bytes"
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

// schemaMember is the archive's first member: what a restore must know
// before it reads a row.
const schemaMember = "schema.json"

// madeBy is what the first member says: the schema version the archive
// was made at, and the version of Quadit that made it.
type madeBy struct {
	Schema  int    `json:"schema"`
	Version string `json:"version"`
}

// Manifest is the last member of an archive. It lists the others with
// their checksums, so an archive can be verified without restoring it.
type Manifest struct {
	Format    int    `json:"format"`
	CreatedAt int64  `json:"created_at"`
	Version   string `json:"version"`
	Database  string `json:"database"`
	// Schema is the schema version of the database the archive was made
	// from; 0 in an archive made before it was recorded.
	Schema  int     `json:"schema,omitempty"`
	Entries []Entry `json:"entries"`
}

// ErrNewerArchive is the refusal of an archive made by a newer Quadit, whose
// schema this one does not know: restored, its rows would lose the tables
// and columns that are new. The error says which version made it.
var ErrNewerArchive = errors.New("the archive is newer than this Quadit")

// skipPrefixes are stored objects that are not users' files.
var skipPrefixes = []string{"backups/", "probe/"}

// Write makes an archive of everything.
func Write(ctx context.Context, st store.Store, files blob.Store, version string, w io.Writer) (Manifest, error) {
	schema, err := st.SchemaVersion(ctx)
	if err != nil {
		return Manifest{}, err
	}
	aw := &archiveWriter{m: Manifest{Format: 1, CreatedAt: time.Now().UnixMilli(), Version: version, Database: st.Dialect(), Schema: schema}}
	gz := gzip.NewWriter(w)
	aw.tw = tar.NewWriter(gz)
	head, _ := json.Marshal(madeBy{Schema: schema, Version: version})
	if err := aw.add(schemaMember, int64(len(head)), bytes.NewReader(head), 0); err != nil {
		return aw.m, err
	}
	// Tables next, in an order that can be loaded back.
	for _, t := range store.Tables() {
		if err := aw.addTable(ctx, st, t.Name); err != nil {
			return aw.m, fmt.Errorf("table %s: %w", t.Name, err)
		}
	}
	if err := aw.addFiles(ctx, files); err != nil {
		return aw.m, err
	}
	if err := aw.addManifest(); err != nil {
		return aw.m, err
	}
	if err := aw.tw.Close(); err != nil {
		return aw.m, err
	}
	return aw.m, gz.Close()
}

// archiveWriter is one run of Write: the archive being written and the
// manifest of what is in it so far.
type archiveWriter struct {
	tw *tar.Writer
	m  Manifest
}

// add writes one member of size bytes, read from r, and lists it in the
// manifest with its checksum.
func (aw *archiveWriter) add(name string, size int64, r io.Reader, rows int) error {
	if err := aw.tw.WriteHeader(&tar.Header{Name: name, Size: size, Mode: 0o600, ModTime: time.UnixMilli(aw.m.CreatedAt)}); err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(aw.tw, h), r)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if n != size {
		return fmt.Errorf("%s: changed size while it was read (%d, then %d)", name, size, n)
	}
	aw.m.Entries = append(aw.m.Entries, Entry{Name: name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil)), Rows: rows})
	return nil
}

// addTable writes every row of a table as JSON lines. They go to a
// temporary file first, as a member's size is written before it.
func (aw *archiveWriter) addTable(ctx context.Context, st store.Store, table string) error {
	tmp, err := os.CreateTemp("", "quadit-backup-*.jsonl")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	bw := bufio.NewWriter(tmp)
	rows := 0
	err = st.Dump(ctx, table, func(row map[string]any) error {
		raw, err := json.Marshal(row)
		if err != nil {
			return err
		}
		rows++
		bw.Write(raw) // a failed write is kept by bw and returned by the next one
		return bw.WriteByte('\n')
	})
	if err != nil {
		return err
	}
	if err := bw.Flush(); err != nil {
		return err
	}
	size, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return aw.add("db/"+table+".jsonl", size, tmp, rows)
}

// addFiles writes every stored file but the ones that are not users'
// (skipPrefixes). A file deleted while the backup runs is left out.
func (aw *archiveWriter) addFiles(ctx context.Context, files blob.Store) error {
	type object struct {
		key  string
		size int64
	}
	var objects []object
	err := files.List(ctx, "", func(k string, n int64) error {
		for _, p := range skipPrefixes {
			if strings.HasPrefix(k, p) {
				return nil
			}
		}
		objects = append(objects, object{k, n})
		return nil
	})
	if err != nil {
		return fmt.Errorf("listing files: %w", err)
	}
	for _, o := range objects {
		r, _, err := files.Open(ctx, o.key)
		if errors.Is(err, blob.ErrNotFound) {
			continue // deleted while the backup ran
		}
		if err != nil {
			return err
		}
		err = aw.add("files/"+o.key, o.size, r, 0)
		r.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// addManifest writes the manifest, the archive's last member.
func (aw *archiveWriter) addManifest() error {
	raw, _ := json.MarshalIndent(aw.m, "", " ")
	if err := aw.tw.WriteHeader(&tar.Header{Name: "manifest.json", Size: int64(len(raw)), Mode: 0o600, ModTime: time.UnixMilli(aw.m.CreatedAt)}); err != nil {
		return err
	}
	_, err := aw.tw.Write(raw)
	return err
}

// read walks an archive, handing each member to each. It returns the
// manifest, which comes last.
func read(r io.Reader, each func(name string, body io.Reader) error) (Manifest, error) {
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
		if err := each(h.Name, tr); err != nil {
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
	m, err := read(r, func(name string, body io.Reader) error {
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

// parentsFirst orders rows so that each comes after the row its cols point
// at, when that row is among them.
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

// tableOf gives the table an archive member holds the rows of, if it holds
// a table's rows.
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

// readable refuses, from its first member, an archive made at a schema
// version newer than the database's: this Quadit would drop what it does
// not know. Every other member is not this one's to judge.
func readable(ctx context.Context, st store.Store, name string, body io.Reader) error {
	if name != schemaMember {
		return nil
	}
	var made madeBy
	if err := json.NewDecoder(body).Decode(&made); err != nil {
		return fmt.Errorf("the archive is damaged: its %s does not read: %w", schemaMember, err)
	}
	ours, err := st.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	if made.Schema > ours {
		return fmt.Errorf("%w: it was made by Quadit %s (schema version %d), and this Quadit knows schema version %d; restore it with Quadit %s or a later version",
			ErrNewerArchive, made.Version, made.Schema, ours, made.Version)
	}
	return nil
}

// Restore loads an archive into an empty database and file store. The rows
// of an archive made at an older schema version are then changed as the
// upgrades since would have changed them in a database of that version
// (store.UpgradeLoaded): a repair an upgrade made is not undone by a
// restore.
func Restore(ctx context.Context, st store.Store, files blob.Store, r io.Reader) (Manifest, error) {
	if n, err := st.Count(ctx, "users"); err != nil {
		return Manifest{}, err
	} else if n > 0 {
		return Manifest{}, errors.New("this database already has data; a full restore goes into an empty one (to bring back one task or page, name it)")
	}
	m, err := read(r, func(name string, body io.Reader) error {
		if err := readable(ctx, st, name, body); err != nil {
			return err
		}
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
	if err != nil {
		return m, err
	}
	if err := st.UpgradeLoaded(ctx, m.Schema); err != nil {
		return m, fmt.Errorf("bringing the archive's rows up to this version: %w", err)
	}
	return m, nil
}

// Item names one task or page to bring back from an archive.
type Item struct {
	Workspace string // slug
	Kind      string // task or doc
	Ref       string // a task key or id, or a page id
}

// RestoreItem brings one task or page back from an archive into a database
// that has moved on, as it was when the archive was made: rows that are
// gone are put back, a row in the trash is taken out of it, and rows that
// changed since are set back. What was added since stays, except in a page:
// blocks the archive does not know are moved to the page's trash, so the
// page reads as it did. It returns the id of the task or page.
func RestoreItem(ctx context.Context, st store.Store, files blob.Store, r io.Reader, it Item) (string, error) {
	ir := &itemRestore{ctx: ctx, st: st, files: files, it: it,
		decisions: map[string]bool{}, keys: map[string]bool{}, pending: map[string]map[string]any{}}
	if _, err := read(r, ir.member); err != nil {
		return "", err
	}
	if ir.wsID == "" {
		return "", fmt.Errorf("the archive has no workspace %q", it.Workspace)
	}
	if ir.rootID == "" {
		return "", fmt.Errorf("the archive has no %s %q in %s", it.Kind, it.Ref, it.Workspace)
	}
	if it.Kind == "doc" {
		if err := ir.trashNewBlocks(); err != nil {
			return "", err
		}
	}
	return ir.rootID, nil
}

// itemRestore is one run of RestoreItem: what it brings back, and what it
// has learnt from the archive so far. Being one run, it holds the run's
// context.
type itemRestore struct {
	ctx   context.Context
	st    store.Store
	files blob.Store
	it    Item

	wsID   string // the workspace's id, once its row is read
	rootID string // the task's or page's id, once its row is read

	decisions map[string]bool           // the task's decisions, by id
	keys      map[string]bool           // the stored files to bring back
	blocks    []string                  // the page's blocks in the archive
	pending   map[string]map[string]any // file rows seen, until we know which are wanted
}

// partOf names, for each table whose rows are parts of a task or a page,
// the columns that say which task or page a row is part of.
var partOf = map[string][]string{
	"task_labels":   {"task_id"},
	"decisions":     {"task_id"},
	"comments":      {"task_id", "doc_id"},
	"task_links":    {"task_id", "doc_id"},
	"doc_blocks":    {"doc_id"},
	"doc_versions":  {"doc_id"},
	"db_properties": {"database_id"},
	"db_views":      {"database_id"},
	"attachments":   {"task_id", "subject_id"},
}

// kept are the columns a row set back keeps as they are now: its place in
// the feed, and a task's number, belong to the database as it is.
var kept = []string{"created_seq", "updated_seq", "activity_seq", "number", "key", "seq"}

// str is a row's text column, or "" when it is not text.
func str(row map[string]any, k string) string { s, _ := row[k].(string); return s }

// member reads one member of the archive: a stored file, brought back if
// it is one of the item's, or a table's rows.
func (ir *itemRestore) member(name string, body io.Reader) error {
	if err := readable(ir.ctx, ir.st, name, body); err != nil {
		return err
	}
	if key, ok := strings.CutPrefix(name, "files/"); ok {
		if ir.keys[key] {
			return ir.files.Put(ir.ctx, key, body, "")
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
			if err := ir.row(table, row); err != nil {
				return fmt.Errorf("%s: %w", table, err)
			}
		}
		return nil
	})
}

// row decides what one row of the archive is to the item: its workspace,
// the item itself, a part of it, or nothing.
func (ir *itemRestore) row(table string, row map[string]any) error {
	switch {
	case table == "workspaces" && str(row, "slug") == ir.it.Workspace:
		ir.wsID = str(row, "id")
		return nil
	case ir.wsID == "" || (str(row, "workspace_id") != ir.wsID && table != "files"):
		return nil // another workspace's
	case ir.isItem(table, row):
		return ir.restoreItem(table, row)
	case ir.rootID == "":
		return nil // nothing can be a part before the item is found
	}
	return ir.restorePart(table, row)
}

// isItem says whether a row is the task or page being brought back.
func (ir *itemRestore) isItem(table string, row map[string]any) bool {
	id := str(row, "id")
	switch {
	case table == "tasks" && ir.it.Kind == "task":
		return strings.EqualFold(str(row, "key"), ir.it.Ref) || id == ir.it.Ref
	case table == "docs" && ir.it.Kind == "doc":
		return id == ir.it.Ref
	}
	return false
}

// restoreItem puts the task or page back, out of the trash, under its
// parent if that is still there.
func (ir *itemRestore) restoreItem(table string, row map[string]any) error {
	id := str(row, "id")
	ir.rootID = id
	row["deleted_at"] = nil
	if table == "tasks" {
		row["deleted_by"] = nil
	}
	if parent := str(row, "parent_id"); parent != "" {
		n, err := ir.st.Count(ir.ctx, table, store.Eq("id", parent))
		if err != nil {
			return err
		}
		if n == 0 {
			row["parent_id"] = nil // its parent is gone for good
		}
	}
	return ir.put(table, row, store.Eq("id", id))
}

// restorePart puts back a row that is part of the item: a label, decision,
// option, comment, link, block, version, property, view or attachment. A
// file row is kept in mind until an attachment asks for it, as files come
// before attachments in the archive.
func (ir *itemRestore) restorePart(table string, row map[string]any) error {
	id := str(row, "id")
	switch {
	case table == "files":
		ir.pending[id] = row
		return nil
	case table == "decision_options":
		if ir.decisions[str(row, "decision_id")] {
			return ir.put(table, row, store.Eq("id", id))
		}
		return nil
	case !ir.isPart(table, row):
		return nil
	}
	switch table {
	case "task_labels":
		return ir.put(table, row, store.Eq("task_id", ir.rootID), store.Eq("label_id", str(row, "label_id")))
	case "decisions":
		ir.decisions[id] = true
	case "doc_blocks":
		ir.blocks = append(ir.blocks, id)
	case "attachments":
		if err := ir.restoreFile(str(row, "file_id")); err != nil {
			return err
		}
	}
	return ir.put(table, row, store.Eq("id", id))
}

// isPart says whether a row of one of the partOf tables belongs to the
// item.
func (ir *itemRestore) isPart(table string, row map[string]any) bool {
	for _, col := range partOf[table] {
		if str(row, col) == ir.rootID {
			return true
		}
	}
	return false
}

// restoreFile puts back the file row an attachment points at, if the
// archive has it, and marks its stored objects to be brought back.
func (ir *itemRestore) restoreFile(fileID string) error {
	f, ok := ir.pending[fileID]
	if !ok {
		return nil
	}
	f["deleted_at"] = nil
	if err := ir.put("files", f, store.Eq("id", fileID)); err != nil {
		return err
	}
	ir.keys[str(f, "storage_key")] = true
	if pk := str(f, "preview_key"); pk != "" {
		ir.keys[pk] = true
	}
	return nil
}

// put sets a row back as the archive has it: over the row if it is still
// here, or in again if it is gone.
func (ir *itemRestore) put(table string, row map[string]any, cond ...store.Cond) error {
	n, err := ir.st.Count(ir.ctx, table, cond...)
	if err != nil {
		return err
	}
	if n > 0 {
		return ir.st.Overwrite(ir.ctx, table, row, kept, cond...)
	}
	return ir.st.Load(ir.ctx, table, []map[string]any{row})
}

// trashNewBlocks moves the blocks written into the page after the archive
// was made to the page's trash.
func (ir *itemRestore) trashNewBlocks() error {
	conds := []store.Cond{store.Eq("doc_id", ir.rootID), store.Null("deleted_at")}
	if len(ir.blocks) > 0 {
		conds = append(conds, store.NotIn("id", ir.blocks))
	}
	_, err := ir.st.Update(ir.ctx, "doc_blocks", map[string]any{"deleted_at": time.Now().UnixMilli()}, conds...)
	return err
}
