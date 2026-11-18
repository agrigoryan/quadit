// Package backup writes and reads the portable archive: every table as
// JSON lines plus every stored file, in one .tar.gz. The same archive is
// made on SQLite and on Postgres, on disk and on cloud storage, and can be
// restored onto any of them.
//
// An archive is the install at one moment: every table is read from one
// snapshot of the database, and the files are the ones its rows name. A
// file removed after that moment is still there to copy, as file storage
// keeps a removed file a day (the server's jobs remove it), and a backup
// that finds one gone all the same fails rather than leave it out.
//
// The archive's first member (schema.json) says the schema version it was
// made at, the Quadit that made it, and a value sealed with the install's
// secret, so a restore can refuse an archive it cannot read whole, or
// whose stored secrets the destination could not open, before it writes
// anything (an archive made without that value is tried on the sealed
// values its rows hold); its last (manifest.json) lists every member with
// its checksum. An archive made before the first member existed has only
// the last.
//
// A full restore reads the archive twice: once to check all of it, the
// rows against each other included, then to load it, every row in one
// transaction. A restore that fails leaves the database empty and takes
// out the files it had stored, so it can be run again.
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
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
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
// was made at, the version of Quadit that made it, and keyCheck sealed
// with the install's secret ("" when the archive was made without it).
type madeBy struct {
	Schema   int    `json:"schema"`
	Version  string `json:"version"`
	KeyCheck string `json:"key_check,omitempty"`
}

// keyCheck is what an archive seals with the install's secret: a restore
// opens it to know that the secret it has opens the archive's secrets.
const keyCheck = "quadit install secret"

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
	// Missing are the stored files the rows name that file storage did not
	// have when the archive was made: lost before it, not by it.
	Missing []string `json:"missing,omitempty"`
}

// ErrNewerArchive is the refusal of an archive made by a newer Quadit, whose
// schema this one does not know: restored, its rows would lose the tables
// and columns that are new. The error says which version made it.
var ErrNewerArchive = errors.New("the archive is newer than this Quadit")

// ErrDamaged is the refusal of a file that is not a whole, readable
// archive. The error says what is wrong with it.
var ErrDamaged = errors.New("the archive is damaged")

// ErrOtherSecret is a full restore's refusal of an archive whose stored
// secrets (sign-in codes, the vault, tokens of integrations, passwords of
// mail and storage) were sealed with another install secret than the one
// given: restored, none of them could be opened.
var ErrOtherSecret = errors.New("the archive's stored secrets were sealed with another install secret")

// ErrNotInArchive is RestoreItem's answer when the archive has no such
// workspace, or no such task or page in it.
var ErrNotInArchive = errors.New("not in the archive")

// Write makes an archive of everything: every table read from one
// snapshot of the database, then the stored files its rows name. sealer
// is the install's secret, which seals the archive's key check; nil
// leaves it out.
func Write(ctx context.Context, st store.Store, files blob.Store, sealer *auth.Sealer, version string, w io.Writer) (Manifest, error) {
	schema, err := st.SchemaVersion(ctx)
	if err != nil {
		return Manifest{}, err
	}
	made := madeBy{Schema: schema, Version: version}
	if sealer != nil {
		if made.KeyCheck, err = sealer.Seal(keyCheck); err != nil {
			return Manifest{}, err
		}
	}
	aw := &archiveWriter{m: Manifest{Format: 1, CreatedAt: time.Now().UnixMilli(), Version: version, Database: st.Dialect(), Schema: schema}, named: map[string]bool{}}
	gz := gzip.NewWriter(w)
	aw.tw = tar.NewWriter(gz)
	head, _ := json.Marshal(made)
	if err := aw.add(schemaMember, int64(len(head)), bytes.NewReader(head), 0); err != nil {
		return aw.m, err
	}
	// Tables next, in an order that can be loaded back, all as they stood
	// at one moment.
	err = st.Snapshot(ctx, func(snap store.Snapshot) error {
		for _, t := range store.Tables() {
			if err := aw.addTable(ctx, snap, t.Name); err != nil {
				return fmt.Errorf("table %s: %w", t.Name, err)
			}
		}
		return nil
	})
	if err != nil {
		return aw.m, err
	}
	if err := aw.addFiles(ctx, st, files); err != nil {
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

// archiveWriter is one run of Write: the archive being written, the
// manifest of what is in it so far, and the stored files its rows name.
type archiveWriter struct {
	tw    *tar.Writer
	m     Manifest
	named map[string]bool // storage keys
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

// addTable writes every row of a table as JSON lines, and notes the stored
// files its rows name. The rows go to a temporary file first, as a
// member's size is written before it.
func (aw *archiveWriter) addTable(ctx context.Context, snap store.Snapshot, table string) error {
	tmp, err := os.CreateTemp("", "quadit-backup-*.jsonl")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	bw := bufio.NewWriter(tmp)
	rows := 0
	err = snap.Dump(ctx, table, func(row map[string]any) error {
		raw, err := json.Marshal(row)
		if err != nil {
			return err
		}
		if table == "files" {
			for _, key := range storedFiles(row) {
				aw.named[key] = true
			}
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

// storedFiles are the keys in file storage a row of the files table
// names: a ready file's bytes, and its reduced copy. An upload still
// arriving names nothing yet: its parts are not kept in an archive.
func storedFiles(row map[string]any) []string {
	if str(row, "state") != core.FileReady {
		return nil
	}
	keys := []string{str(row, "storage_key")}
	if pk := str(row, "preview_key"); pk != "" {
		keys = append(keys, pk)
	}
	return keys
}

// addFiles writes the stored files the rows name. One file storage does
// not have is a file lost before the backup, when the database still
// names it, and is listed as missing; one removed since the rows were read
// (kept a day by the server, so only in a backup that took longer) fails
// the backup, which would otherwise be no longer one moment.
func (aw *archiveWriter) addFiles(ctx context.Context, st store.Store, files blob.Store) error {
	keys := make([]string, 0, len(aw.named))
	for k := range aw.named {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, key := range keys {
		r, err := openStored(ctx, files, key)
		if errors.Is(err, blob.ErrNotFound) {
			named, err := st.Count(ctx, "files", store.Either(store.Eq("storage_key", key), store.Eq("preview_key", key)))
			if err != nil {
				return err
			}
			if named == 0 {
				return fmt.Errorf("the stored file %s was removed while the backup ran; run it again", key)
			}
			aw.m.Missing = append(aw.m.Missing, key)
			continue
		}
		if err != nil {
			return err
		}
		err = aw.addStored(key, r)
		r.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// openStored opens a stored file, and looks once more when it is not
// found: an install moving its files from disk to the cloud may have moved
// it between the two looks a layered store takes.
func openStored(ctx context.Context, files blob.Store, key string) (io.ReadSeekCloser, error) {
	r, _, err := files.Open(ctx, key)
	if errors.Is(err, blob.ErrNotFound) {
		r, _, err = files.Open(ctx, key)
	}
	return r, err
}

// addStored writes one stored file as a member.
func (aw *archiveWriter) addStored(key string, r io.ReadSeeker) error {
	size, err := r.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return aw.add("files/"+key, size, r, 0)
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
		return m, fmt.Errorf("%w: this is not a backup archive: %w", ErrDamaged, err)
	}
	tr := tar.NewReader(gz)
	found := false
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return m, fmt.Errorf("%w: %w", ErrDamaged, err)
		}
		if h.Name == "manifest.json" {
			if err := json.NewDecoder(tr).Decode(&m); err != nil {
				return m, fmt.Errorf("%w: its manifest does not read: %w", ErrDamaged, err)
			}
			found = true
			continue
		}
		if err := each(h.Name, tr); err != nil {
			return m, err
		}
	}
	if !found {
		return m, fmt.Errorf("%w: it has no manifest, so it is incomplete", ErrDamaged)
	}
	return m, nil
}

// Verify reads a whole archive and checks it: every member against the
// manifest's checksums, and the rows against each other where a restore
// depends on it (a workspace's feed is not ahead of its sequence; every
// stored file a row names is in it, or was missing when it was made).
func Verify(r io.Reader) (Manifest, error) {
	return check(r, nil, nil)
}

// check is Verify, handing what the first member says to first, when the
// archive has one, before it reads further, and each value its rows hold
// sealed (sealedIn) to sawSealed. Either may be nil.
func check(r io.Reader, first func(madeBy) error, sawSealed func(string)) (Manifest, error) {
	sums := map[string]Entry{}
	rows := &consistency{seq: map[string]int64{}, lastEvent: map[string]int64{}, named: map[string]bool{}, sawSealed: sawSealed}
	m, err := read(r, func(name string, body io.Reader) error {
		h := sha256.New()
		counted := &countingWriter{w: h}
		body = io.TeeReader(body, counted)
		if name == schemaMember && first != nil {
			var made madeBy
			if err := json.NewDecoder(body).Decode(&made); err != nil {
				return fmt.Errorf("%w: its %s does not read: %w", ErrDamaged, schemaMember, err)
			}
			if err := first(made); err != nil {
				return err
			}
		}
		if table, ok := tableOf(name); ok {
			if err := rows.read(table, body); err != nil {
				return err
			}
		}
		if _, err := io.Copy(io.Discard, body); err != nil {
			return fmt.Errorf("%w: %w", ErrDamaged, err)
		}
		sums[name] = Entry{Name: name, Size: counted.n, SHA256: hex.EncodeToString(h.Sum(nil))}
		return nil
	})
	if err != nil {
		return m, err
	}
	for _, e := range m.Entries {
		got, ok := sums[e.Name]
		if !ok {
			return m, fmt.Errorf("%w: it is missing %s", ErrDamaged, e.Name)
		}
		if got.SHA256 != e.SHA256 || got.Size != e.Size {
			return m, fmt.Errorf("%w: %s does not match its checksum", ErrDamaged, e.Name)
		}
	}
	if len(sums) != len(m.Entries) {
		return m, fmt.Errorf("%w: it holds members its manifest does not list", ErrDamaged)
	}
	return m, rows.check(sums, m.Missing)
}

// countingWriter counts what is written through it.
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// consistency is what check learns of the rows of an archive that must
// agree with each other: each workspace's sequence and the last event of
// its feed, and the stored files the rows name; and, for a restore, the
// values the rows hold sealed.
type consistency struct {
	seq       map[string]int64 // workspace id -> its sequence
	lastEvent map[string]int64 // workspace id -> the number of its last event
	named     map[string]bool  // storage keys
	// sawSealed is given every value the rows hold sealed (sealedIn); nil
	// when nobody asked.
	sawSealed func(string)
}

// read takes in the rows of one table, when they are of a table it checks,
// or when it looks for sealed values.
func (c *consistency) read(table string, body io.Reader) error {
	number := func(row map[string]any, col string) int64 { n, _ := row[col].(float64); return int64(n) }
	var take func(row map[string]any)
	switch table {
	case "workspaces":
		take = func(row map[string]any) { c.seq[str(row, "id")] = number(row, "seq") }
	case "events":
		take = func(row map[string]any) {
			ws := str(row, "workspace_id")
			c.lastEvent[ws] = max(c.lastEvent[ws], number(row, "seq"))
		}
	case "files":
		take = func(row map[string]any) {
			for _, key := range storedFiles(row) {
				c.named[key] = true
			}
		}
	}
	sealed := sealedIn[table]
	if c.sawSealed == nil {
		sealed = nil
	}
	if take == nil && sealed == nil {
		return nil
	}
	return lines(body, 1000, func(rows []map[string]any) error {
		for _, row := range rows {
			if take != nil {
				take(row)
			}
			if sealed != nil {
				for _, v := range sealed(row) {
					c.sawSealed(v)
				}
			}
		}
		return nil
	})
}

// sealedIn is where Quadit keeps values sealed with the install secret: for
// each table that holds some, the values of a row (as an archive holds it)
// that are sealed. Only these say which secret an archive was sealed with:
// what people write may look sealed, or be, and says nothing of it.
var sealedIn = map[string]func(row map[string]any) []string{
	"users":        sealedColumn("totp_secret"),
	"secrets":      sealedColumn("value"),
	"integrations": sealedColumn("secret"),
	// A setting's value is JSON, an object for one with secret fields:
	// package settings seals those at its top level, and its other fields
	// are the install's configuration, never anything that looks sealed.
	"settings": func(row map[string]any) []string {
		value, _ := row["value"].(map[string]any)
		var out []string
		for _, field := range value {
			if v, ok := field.(string); ok && auth.LooksSealed(v) {
				out = append(out, v)
			}
		}
		return out
	},
}

// sealedColumn is the value of a column that holds a sealed value, when
// it holds one.
func sealedColumn(col string) func(row map[string]any) []string {
	return func(row map[string]any) []string {
		if v, _ := row[col].(string); v != "" {
			return []string{v}
		}
		return nil
	}
}

// check says how the rows disagree, if they do: a workspace whose feed is
// ahead of its sequence (a restored install would number its next event
// as one it has), or a stored file named but neither in the archive
// (members) nor missing when it was made.
func (c *consistency) check(members map[string]Entry, missing []string) error {
	for ws, last := range c.lastEvent {
		if seq, ok := c.seq[ws]; ok && last > seq {
			return fmt.Errorf("%w: workspace %s has events up to %d and its sequence says %d", ErrDamaged, ws, last, seq)
		}
	}
	for key := range c.named {
		if _, ok := members["files/"+key]; !ok && !slices.Contains(missing, key) {
			return fmt.Errorf("%w: it does not hold the stored file %s, which its rows name", ErrDamaged, key)
		}
	}
	return nil
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
			return fmt.Errorf("%w: a row does not read: %w", ErrDamaged, err)
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

// readable refuses an archive made at a schema version newer than the
// database's: this Quadit would drop what it does not know.
func readable(ctx context.Context, st store.Store, made madeBy) error {
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

// Restore loads an archive into an empty database and file store. It
// first reads the whole archive and checks it (Verify, a schema this
// Quadit knows, and the install secret), so a damaged or unreadable one is
// refused before anything is written; it then loads every row in one
// transaction and stores the files meanwhile. When anything fails, the
// database is left empty and the files stored are taken out again, so the
// restore can be run again. The rows of an archive made at an older schema
// version are changed, in the same transaction, as the upgrades since
// would have changed them (store.Loader's UpgradeLoaded): a repair an
// upgrade made is not undone by a restore.
//
// sealer is the install secret the restored install will run with: an
// archive whose stored secrets were sealed with another is refused
// (secretProof, ErrOtherSecret). nil is for an install whose secret is
// lost: the archive is restored, and what it sealed stays sealed for good.
func Restore(ctx context.Context, st store.Store, files blob.Store, sealer *auth.Sealer, archive io.ReadSeeker) (Manifest, error) {
	if n, err := st.Count(ctx, "users"); err != nil {
		return Manifest{}, err
	} else if n > 0 {
		return Manifest{}, errors.New("this database already has data; a full restore goes into an empty one (to bring back one task or page, name it)")
	}
	proof := &secretProof{sealer: sealer}
	m, err := check(archive, func(made madeBy) error {
		if err := readable(ctx, st, made); err != nil {
			return err
		}
		return proof.keyCheck(made)
	}, proof.sawSealed)
	if err == nil {
		err = proof.result()
	}
	if err != nil {
		return m, err
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return m, err
	}
	var stored []string
	err = st.Restore(ctx, func(l store.Loader) error {
		if _, err := read(archive, func(name string, body io.Reader) error {
			if key, ok := strings.CutPrefix(name, "files/"); ok {
				stored = append(stored, key)
				return files.Put(ctx, key, body, "")
			}
			return load(ctx, l, name, body)
		}); err != nil {
			return err
		}
		if err := l.UpgradeLoaded(ctx, m.Schema); err != nil {
			return fmt.Errorf("bringing the archive's rows up to this version: %w", err)
		}
		return nil
	})
	if err != nil {
		// The rows are gone with the transaction; the files go too, even when
		// the restore was cut off.
		for _, key := range stored {
			if derr := files.Delete(context.WithoutCancel(ctx), key); derr != nil {
				err = errors.Join(err, fmt.Errorf("the stored file %s is left behind: %w", key, derr))
			}
		}
		return m, err
	}
	return m, nil
}

// secretProof is how a full restore knows that the install secret it has
// opens the archive's stored secrets: by the key check an archive carries,
// or, in one made without it (before archives had one, or without the
// install's secret at hand), by a stored secret of its rows that opens. An
// archive that holds no stored secret has nothing a wrong secret could
// lose, and passes. With no secret (a lost one), nothing is asked.
type secretProof struct {
	sealer  *auth.Sealer
	checked bool // the archive carries a key check (which opened, or check stopped)
	sealed  bool // the rows hold a sealed value
	opened  bool // and one of them opened
}

// keyCheck opens the key check of an archive that has one.
func (p *secretProof) keyCheck(made madeBy) error {
	if p.sealer == nil || made.KeyCheck == "" {
		return nil
	}
	p.checked = true
	if opened, err := p.sealer.Open(made.KeyCheck); err != nil || opened != keyCheck {
		return ErrOtherSecret
	}
	return nil
}

// sawSealed tries a value the rows hold sealed, until one opens.
func (p *secretProof) sawSealed(v string) {
	if p.sealer == nil || p.checked || p.opened {
		return
	}
	p.sealed = true
	_, err := p.sealer.Open(v)
	p.opened = err == nil
}

// result refuses an archive whose rows hold sealed values, none of which
// opened, when it had no key check to say so first.
func (p *secretProof) result() error {
	if p.sealed && !p.opened {
		return ErrOtherSecret
	}
	return nil
}

// load loads one member of an archive that holds a table's rows.
func load(ctx context.Context, l store.Loader, name string, body io.Reader) error {
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
		return l.Load(ctx, table, rows)
	})
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
// page reads as it did. The rows are set back, and the feed told, in one
// write to eng's database (engine.RestoreFromBackup): a restore that fails
// leaves the database as it was. Only the item's stored files, which are
// put back first, may stay. It returns the id of the task or page.
func RestoreItem(ctx context.Context, eng *engine.Engine, files blob.Store, r io.Reader, it Item) (string, error) {
	ir := &itemRestore{ctx: ctx, st: eng.Store(), files: files, it: it,
		decisions: map[string]bool{}, keys: map[string]bool{}, pending: map[string]map[string]any{}}
	if _, err := read(r, ir.member); err != nil {
		return "", err
	}
	if ir.wsID == "" {
		return "", fmt.Errorf("workspace %q is %w", it.Workspace, ErrNotInArchive)
	}
	if ir.rootID == "" {
		return "", fmt.Errorf("%s %q of %s is %w", it.Kind, it.Ref, it.Workspace, ErrNotInArchive)
	}
	if err := eng.RestoreFromBackup(ctx, ir.wsID, it.Kind, ir.rootID, ir.setBack); err != nil {
		return "", err
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

	item      archived                  // the task's or page's own row
	parts     []archived                // the rows that are parts of it, in archive order
	decisions map[string]bool           // the task's decisions, by id
	keys      map[string]bool           // the stored files to bring back
	blocks    []string                  // the page's blocks in the archive
	pending   map[string]map[string]any // file rows seen, until we know which are wanted
}

// archived is a row of the archive to set back, and the conditions that
// find it in the database if it is still there.
type archived struct {
	table string
	row   map[string]any
	where []store.Cond
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
	if name == schemaMember {
		var made madeBy
		if err := json.NewDecoder(body).Decode(&made); err != nil {
			return fmt.Errorf("%w: its %s does not read: %w", ErrDamaged, schemaMember, err)
		}
		return readable(ir.ctx, ir.st, made)
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
			ir.row(table, row)
		}
		return nil
	})
}

// row decides what one row of the archive is to the item: its workspace,
// the item itself, a part of it, or nothing.
func (ir *itemRestore) row(table string, row map[string]any) {
	switch {
	case table == "workspaces" && str(row, "slug") == ir.it.Workspace:
		ir.wsID = str(row, "id")
	case ir.wsID == "" || (str(row, "workspace_id") != ir.wsID && table != "files"):
		// another workspace's
	case ir.isItem(table, row):
		ir.rootID = str(row, "id")
		row["deleted_at"] = nil // out of the trash
		if table == "tasks" {
			row["deleted_by"] = nil
		}
		ir.item = archived{table, row, []store.Cond{store.Eq("id", ir.rootID)}}
	case ir.rootID != "": // nothing can be a part before the item is found
		ir.part(table, row)
	}
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

// part takes in a row that is part of the item: a label, decision,
// option, comment, link, block, version, property, view or attachment. A
// file row is kept in mind until an attachment asks for it, as files come
// before attachments in the archive; the file is then taken out of the
// trash, and its stored objects are marked to be brought back.
func (ir *itemRestore) part(table string, row map[string]any) {
	id := str(row, "id")
	byID := []store.Cond{store.Eq("id", id)}
	switch {
	case table == "files":
		ir.pending[id] = row
		return
	case table == "decision_options":
		if ir.decisions[str(row, "decision_id")] {
			ir.parts = append(ir.parts, archived{table, row, byID})
		}
		return
	case !ir.isPart(table, row):
		return
	}
	switch table {
	case "task_labels":
		byID = []store.Cond{store.Eq("task_id", ir.rootID), store.Eq("label_id", str(row, "label_id"))}
	case "decisions":
		ir.decisions[id] = true
	case "doc_blocks":
		ir.blocks = append(ir.blocks, id)
	case "attachments":
		if f, ok := ir.pending[str(row, "file_id")]; ok {
			f["deleted_at"] = nil
			ir.parts = append(ir.parts, archived{"files", f, []store.Cond{store.Eq("id", str(f, "id"))}})
			ir.keys[str(f, "storage_key")] = true
			if pk := str(f, "preview_key"); pk != "" {
				ir.keys[pk] = true
			}
		}
	}
	ir.parts = append(ir.parts, archived{table, row, byID})
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

// setBack writes what was read, in tx: the item under its parent if that
// is still there, then its parts, each over its row if it is still here or
// in again if it is gone. In a page, the blocks written after the archive
// was made are then moved to the page's trash.
func (ir *itemRestore) setBack(tx store.Tx) error {
	if parent := str(ir.item.row, "parent_id"); parent != "" {
		n, err := tx.Count(ir.ctx, ir.item.table, store.Eq("id", parent))
		if err != nil {
			return err
		}
		if n == 0 {
			ir.item.row["parent_id"] = nil // its parent is gone for good
		}
	}
	for _, a := range append([]archived{ir.item}, ir.parts...) {
		n, err := tx.Count(ir.ctx, a.table, a.where...)
		if err != nil {
			return fmt.Errorf("%s: %w", a.table, err)
		}
		if n > 0 {
			err = tx.Overwrite(ir.ctx, a.table, a.row, kept, a.where...)
		} else {
			err = tx.Load(ir.ctx, a.table, []map[string]any{a.row})
		}
		if err != nil {
			return fmt.Errorf("%s: %w", a.table, err)
		}
	}
	if ir.it.Kind != "doc" {
		return nil
	}
	conds := []store.Cond{store.Eq("doc_id", ir.rootID), store.Null("deleted_at")}
	if len(ir.blocks) > 0 {
		conds = append(conds, store.NotIn("id", ir.blocks))
	}
	_, err := tx.Update(ir.ctx, "doc_blocks", map[string]any{"deleted_at": time.Now().UnixMilli()}, conds...)
	return err
}
