package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Backups on a schedule and on request, restoring one item from a backup,
// and the daily emptying of the trash.

// backupRoutes are the routes of the install's backups.
func (s *Server) backupRoutes() []route {
	return []route{
		{"GET /api/v1/admin/backups", s.signedIn(s.installAdmin(s.handleListBackups)), "The backups taken.", "", "install"},
		{"POST /api/v1/admin/backups", s.signedIn(s.installAdmin(s.handleCreateBackup)), "Take a backup now.", "", "install"},
		{"POST /api/v1/admin/backups/{id}/restore-item", s.signedIn(s.installAdmin(s.handleRestoreItemFromBackup)), "Bring one task or page back from a backup, as it was then. Body: {workspace, task} or {workspace, doc}.", "", "install"},
		{"GET /api/v1/admin/backups/{id}/download", s.signedIn(s.installAdmin(s.handleDownloadBackup)), "Download a backup archive.", "", "install"},
	}
}

// How long what is thrown away is kept.
const (
	trashKeep          = 30 * 24 * time.Hour // the trash, and deleted workspaces
	oneTimeTokenKeep   = 24 * time.Hour      // one-time secrets, after they expire
	endedSessionKeep   = 7 * 24 * time.Hour  // sessions, after they end
	defaultBackupsKept = 14
)

// jobBackup writes the scheduled backup.
func (s *Server) jobBackup(ctx context.Context, _ core.Job) error {
	_, err := s.runBackup(ctx)
	return err
}

// jobPurgeTrash empties the trash of what is over 30 days old, removes the
// workspaces deleted that long ago with their files, and drops old
// one-time secrets and ended sessions. The rows are gone before their files
// are removed, so a file that cannot be removed is logged: nothing would
// find it again.
func (s *Server) jobPurgeTrash(ctx context.Context, _ core.Job) error {
	n, keys, err := s.eng.PurgeTrash(ctx, trashKeep)
	for _, k := range keys {
		s.removeStoredFile(ctx, k)
	}
	if n > 0 {
		s.log.Info("emptied the trash", "items", n)
	}
	// Workspaces deleted a month ago go for good, with their files.
	prefixes, werr := s.eng.PurgeWorkspaces(ctx, trashKeep)
	for _, prefix := range prefixes {
		var keys []string
		if lerr := s.fileStore().List(ctx, prefix, func(key string, _ int64) error { keys = append(keys, key); return nil }); lerr != nil {
			s.log.Error("listing the files of a deleted workspace; they are left behind", "prefix", prefix, "err", lerr)
		}
		for _, k := range keys {
			s.removeStoredFile(ctx, k)
		}
		s.log.Info("removed a deleted workspace for good", "files", len(keys))
	}
	if err == nil {
		err = werr
	}
	// Old one-time secrets and ended sessions go too.
	now := time.Now().UnixMilli()
	if _, derr := s.st.Delete(ctx, "one_time_tokens", store.Lt("expires_at", now-oneTimeTokenKeep.Milliseconds())); derr != nil {
		s.log.Warn("dropping old one-time secrets; tried again tomorrow", "err", derr)
	}
	if _, derr := s.st.Delete(ctx, "sessions", store.Lt("expires_at", now-endedSessionKeep.Milliseconds())); derr != nil {
		s.log.Warn("dropping ended sessions; tried again tomorrow", "err", derr)
	}
	return err
}

// removeStoredFile removes a file whose row is gone, logging a failure.
func (s *Server) removeStoredFile(ctx context.Context, key string) {
	if err := s.fileStore().Delete(ctx, key); err != nil {
		s.log.Error("removing a file that was purged; it is left behind", "key", key, "err", err)
	}
}

// backupSetting is the "backup" setting of the admin area.
type backupSetting struct {
	Enabled bool `json:"enabled"`
	Hour    int  `json:"hour"` // hour of the day, UTC, to run at
	Keep    int  `json:"keep"` // how many to keep; default 14
	// CopyToFiles also puts each archive in file storage, which is how a
	// backup gets off the machine when storage is in the cloud.
	CopyToFiles bool `json:"copy_to_files"`
}

// runSchedule starts the daily jobs: a backup when they are turned on, and
// emptying the trash of what is over 30 days old.
func (s *Server) runSchedule(ctx context.Context) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	for {
		now := time.Now().UTC()
		day := now.Format("2006-01-02")
		if err := s.enqueue(ctx, "trash.purge", "", "trash.purge:"+day, nil, now); err != nil {
			s.log.Error("the daily emptying of the trash; queued again on the next pass", "err", err)
		}
		var bs backupSetting
		if s.settings.Get(ctx, "backup", &bs) && bs.Enabled && now.Hour() >= bs.Hour {
			var today []core.Backup
			start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
			if err := s.st.List(ctx, &today, store.Q{Where: []store.Cond{store.Gte("started_at", start)}, Limit: 1}); err == nil && len(today) == 0 {
				if err := s.enqueue(ctx, "backup", "", "backup:"+day, nil, now); err != nil {
					s.log.Error("the daily backup; queued again on the next pass", "err", err)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// backupDir is where archives are written.
func (s *Server) backupDir() string { return filepath.Join(s.cfg.DataDir, "backups") }

// runBackup writes an archive, reads it back to verify it, records it, and
// drops the oldest beyond the number to keep.
func (s *Server) runBackup(ctx context.Context) (core.Backup, error) {
	var setting backupSetting
	s.settings.Get(ctx, "backup", &setting)
	b := core.Backup{ID: id.New(), StartedAt: time.Now().UnixMilli()}
	if err := os.MkdirAll(s.backupDir(), 0o750); err != nil {
		return b, err
	}
	name := "quadit-" + time.Now().UTC().Format("20060102-150405") + ".tar.gz"
	path := filepath.Join(s.backupDir(), name)
	b.Location = path
	if err := s.st.Insert(ctx, b); err != nil {
		return b, err
	}

	// finish records how the backup ended. A failed one's archive is
	// removed. The record is written even when ctx has ended, so it does not
	// stay unfinished.
	finish := func(err error) (core.Backup, error) {
		b.FinishedAt = time.Now().UnixMilli()
		set := map[string]any{"finished_at": b.FinishedAt, "size": b.Size, "sha256": b.SHA256, "verified_at": b.VerifiedAt, "location": b.Location}
		if err != nil {
			b.Error = oneLine(err.Error(), lastErrorSize)
			set["error"] = b.Error
			os.Remove(path)
			s.log.Error("backup failed", "err", err)
		}
		if _, uerr := s.st.Update(context.WithoutCancel(ctx), "backups", set, store.Eq("id", b.ID)); uerr != nil {
			s.log.Error("recording how a backup ended", "backup", b.ID, "err", uerr)
		}
		return b, err
	}

	// Write the archive, noting its size and checksum.
	out, err := os.Create(path)
	if err != nil {
		return finish(err)
	}
	h := sha256.New()
	_, err = backup.Write(ctx, s.st, s.fileStore(), s.cfg.Version, io.MultiWriter(out, h))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return finish(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return finish(err)
	}
	b.Size, b.SHA256 = info.Size(), hex.EncodeToString(h.Sum(nil))

	// Read it back: a backup that cannot be read back is not a backup.
	in, err := os.Open(path)
	if err != nil {
		return finish(err)
	}
	_, err = backup.Verify(in)
	in.Close()
	if err != nil {
		return finish(fmt.Errorf("the archive did not verify: %w", err))
	}
	b.VerifiedAt = time.Now().UnixMilli()

	// Put it in file storage too when the setting says so, which is how a
	// backup gets off the machine.
	if setting.CopyToFiles {
		in, err := os.Open(path)
		if err != nil {
			return finish(err)
		}
		err = s.fileStore().Put(ctx, "backups/"+name, in, "application/gzip")
		in.Close()
		if err != nil {
			return finish(fmt.Errorf("copying the archive to file storage: %w", err))
		}
	}

	s.dropOldBackups(ctx, setting)
	s.log.Info("backup written and verified", "file", path, "bytes", b.Size)
	return finish(nil)
}

// dropOldBackups keeps the newest few archives the setting asks for and
// removes the rest, with their copies in file storage and their records.
// What cannot be removed is logged and tried again after the next backup.
func (s *Server) dropOldBackups(ctx context.Context, setting backupSetting) {
	keep := setting.Keep
	if keep <= 0 {
		keep = defaultBackupsKept
	}
	dir := s.backupDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		s.log.Warn("listing old backups to drop", "err", err)
		return
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "quadit-") && strings.HasSuffix(e.Name(), ".tar.gz") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for ; len(names) > keep; names = names[1:] {
		old := filepath.Join(dir, names[0])
		if err := os.Remove(old); err != nil {
			s.log.Warn("dropping an old backup", "file", old, "err", err)
			continue
		}
		if setting.CopyToFiles {
			if err := s.fileStore().Delete(ctx, "backups/"+names[0]); err != nil {
				s.log.Warn("dropping the copy of an old backup", "file", names[0], "err", err)
			}
		}
		if _, err := s.st.Delete(ctx, "backups", store.Eq("location", old)); err != nil {
			s.log.Warn("dropping the record of an old backup", "file", old, "err", err)
		}
	}
}

// handleListBackups lists the newest backups, with the schedule.
func (s *Server) handleListBackups(x *c) error {
	var list []core.Backup
	if err := s.st.List(x.ctx(), &list, store.Q{Order: "-started_at", Limit: 100}); err != nil {
		return err
	}
	var bs backupSetting
	s.settings.Get(x.ctx(), "backup", &bs)
	return x.ok(map[string]any{"backups": list, "schedule": bs, "directory": s.backupDir()})
}

// handleCreateBackup writes a backup right away and waits for it.
func (s *Server) handleCreateBackup(x *c) error {
	b, err := s.runBackup(x.ctx())
	if err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: "the backup failed: " + err.Error()}
	}
	s.audit(x.r, "", x.user, "backup.created", "backup", b.ID, nil)
	return x.json(201, b)
}

// handleDownloadBackup sends a finished backup's archive.
func (s *Server) handleDownloadBackup(x *c) error {
	b, err := s.finishedBackup(x.ctx(), x.r.PathValue("id"))
	if err != nil {
		return err
	}
	f, err := os.Open(b.Location)
	if err != nil {
		return errNotFound("backup file")
	}
	defer f.Close()
	s.audit(x.r, "", x.user, "backup.downloaded", "backup", b.ID, nil)
	x.w.Header().Set("Content-Type", "application/gzip")
	x.w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(b.Location)+`"`)
	http.ServeContent(x.w, x.r, "", time.UnixMilli(b.FinishedAt), f)
	return nil
}

// finishedBackup reads a backup that finished without an error; any
// other is not found.
func (s *Server) finishedBackup(ctx context.Context, backupID string) (core.Backup, error) {
	var b core.Backup
	if err := s.st.Get(ctx, &b, store.Eq("id", backupID)); err != nil {
		return b, err
	}
	if b.FinishedAt == 0 || b.Error != "" {
		return b, errNotFound("backup")
	}
	return b, nil
}

// handleRestoreItemFromBackup brings one task or one page back from a backup, as it
// was then, into the install as it is now. Body: {workspace: slug, task:
// key or id} or {workspace, doc: page id}.
func (s *Server) handleRestoreItemFromBackup(x *c) error {
	var b struct {
		Workspace string `json:"workspace"`
		Task      string `json:"task"`
		Doc       string `json:"doc"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	bk, err := s.finishedBackup(ctx, x.r.PathValue("id"))
	if err != nil {
		return err
	}
	it := backup.Item{Workspace: b.Workspace, Kind: "task", Ref: b.Task}
	if b.Doc != "" {
		it.Kind, it.Ref = "doc", b.Doc
	}
	if it.Workspace == "" || it.Ref == "" {
		return errBad("say which workspace, and which task (its key) or page (its id)")
	}
	f, err := os.Open(bk.Location)
	if errors.Is(err, fs.ErrNotExist) {
		return errNotFound("backup file")
	}
	if err != nil {
		return err
	}
	defer f.Close()
	rid, err := backup.RestoreItem(ctx, s.st, s.fileStore(), f, it)
	switch {
	case errors.Is(err, backup.ErrNotInArchive):
		return &engine.Error{Code: engine.CodeNotFound, Message: err.Error()}
	case errors.Is(err, backup.ErrNewerArchive), errors.Is(err, backup.ErrDamaged):
		return &engine.Error{Code: engine.CodeConflict, Message: err.Error()}
	case err != nil:
		return err
	}
	var ws core.Workspace
	there, err := store.Find(ctx, s.st, &ws, store.Eq("slug", it.Workspace), store.Live)
	if err != nil {
		return err
	}
	if !there {
		return errNotFound("workspace " + it.Workspace)
	}
	// Tell open browsers, and put the text back in the search index.
	if err := s.eng.AnnounceRestored(ctx, ws.ID, it.Kind, rid); err != nil {
		return err
	}
	if err := s.eng.Reindex(ctx, ws.ID); err != nil {
		// The item is back; only searching for it waits for the next reindex.
		s.log.Error("restore from backup: reindexing", "workspace", ws.Slug, "err", err)
	}
	s.audit(x.r, ws.ID, x.user, it.Kind+".restored_from_backup", it.Kind, rid, map[string]string{"backup": bk.ID, "ref": it.Ref})
	return x.ok(map[string]any{"restored": it.Kind, "id": rid, "workspace": ws.Slug})
}
