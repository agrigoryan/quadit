package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
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

func init() {
	runners = append(runners, (*Server).runSchedule)
	jobKinds["backup"] = func(s *Server, ctx context.Context, j core.Job) error {
		_, err := s.runBackup(ctx)
		return err
	}
	jobKinds["trash.purge"] = func(s *Server, ctx context.Context, j core.Job) error {
		n, keys, err := s.eng.PurgeTrash(ctx, 30*24*time.Hour)
		for _, k := range keys {
			s.fileStore().Delete(ctx, k)
		}
		if n > 0 {
			s.log.Info("emptied the trash", "items", n)
		}
		// Workspaces deleted a month ago go for good, with their files.
		prefixes, werr := s.eng.PurgeWorkspaces(ctx, 30*24*time.Hour)
		for _, prefix := range prefixes {
			var keys []string
			s.fileStore().List(ctx, prefix, func(key string, _ int64) error { keys = append(keys, key); return nil })
			for _, k := range keys {
				s.fileStore().Delete(ctx, k)
			}
			s.log.Info("removed a deleted workspace for good", "files", len(keys))
		}
		if err == nil {
			err = werr
		}
		// Old one-time secrets and ended sessions go too.
		now := time.Now().UnixMilli()
		s.st.Delete(ctx, "one_time_tokens", store.Lt("expires_at", now-24*3600_000))
		s.st.Delete(ctx, "sessions", store.Lt("expires_at", now-7*24*3600_000))
		return err
	}
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/admin/backups", s.signedIn(s.installAdmin(s.handleListBackups)))
		m.HandleFunc("POST /api/v1/admin/backups", s.signedIn(s.installAdmin(s.handleCreateBackup)))
		m.HandleFunc("POST /api/v1/admin/backups/{id}/restore-item", s.signedIn(s.installAdmin(s.handleRestoreItemFromBackup)))
		m.HandleFunc("GET /api/v1/admin/backups/{id}/download", s.signedIn(s.installAdmin(s.handleDownloadBackup)))
	})
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
		s.enqueue(ctx, "trash.purge", "", "trash.purge:"+day, nil, now)
		var bs backupSetting
		if s.setting(ctx, "backup", &bs) && bs.Enabled && now.Hour() >= bs.Hour {
			var today []core.Backup
			start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
			if err := s.st.List(ctx, &today, store.Q{Where: []store.Cond{store.Gte("started_at", start)}, Limit: 1}); err == nil && len(today) == 0 {
				s.enqueue(ctx, "backup", "", "backup:"+day, nil, now)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Server) backupDir() string { return filepath.Join(s.cfg.DataDir, "backups") }

// runBackup writes an archive, reads it back to verify it, records it, and
// drops the oldest beyond the number to keep.
func (s *Server) runBackup(ctx context.Context) (core.Backup, error) {
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
	finish := func(err error) (core.Backup, error) {
		b.FinishedAt = time.Now().UnixMilli()
		set := map[string]any{"finished_at": b.FinishedAt, "size": b.Size, "sha256": b.SHA256, "verified_at": b.VerifiedAt, "location": b.Location}
		if err != nil {
			b.Error = oneLine(err.Error(), 400)
			set["error"] = b.Error
			os.Remove(path)
			s.log.Error("backup failed", "err", err)
		}
		s.st.Update(context.WithoutCancel(ctx), "backups", set, store.Eq("id", b.ID))
		return b, err
	}
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
	st, _ := os.Stat(path)
	b.Size, b.SHA256 = st.Size(), hex.EncodeToString(h.Sum(nil))
	// A backup that cannot be read back is not a backup.
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
	var bs backupSetting
	s.setting(ctx, "backup", &bs)
	if bs.CopyToFiles {
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
	// Keep the newest few.
	keep := bs.Keep
	if keep <= 0 {
		keep = 14
	}
	entries, _ := os.ReadDir(s.backupDir())
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "quadit-") && strings.HasSuffix(e.Name(), ".tar.gz") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > keep {
		os.Remove(filepath.Join(s.backupDir(), names[0]))
		if bs.CopyToFiles {
			s.fileStore().Delete(ctx, "backups/"+names[0])
		}
		s.st.Delete(ctx, "backups", store.Eq("location", filepath.Join(s.backupDir(), names[0])))
		names = names[1:]
	}
	s.log.Info("backup written and verified", "file", path, "bytes", b.Size)
	return finish(nil)
}

func (s *Server) handleListBackups(x *c) error {
	var list []core.Backup
	if err := s.st.List(x.ctx(), &list, store.Q{Order: "-started_at", Limit: 100}); err != nil {
		return err
	}
	var bs backupSetting
	s.setting(x.ctx(), "backup", &bs)
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

func (s *Server) handleDownloadBackup(x *c) error {
	var b core.Backup
	if err := s.st.Get(x.ctx(), &b, store.Eq("id", x.r.PathValue("id"))); err != nil || b.FinishedAt == 0 || b.Error != "" {
		return errNotFound("backup")
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
	var bk core.Backup
	if err := s.st.Get(ctx, &bk, store.Eq("id", x.r.PathValue("id"))); err != nil || bk.FinishedAt == 0 || bk.Error != "" {
		return errNotFound("backup")
	}
	it := backup.Item{Workspace: b.Workspace, Kind: "task", Ref: b.Task}
	if b.Doc != "" {
		it.Kind, it.Ref = "doc", b.Doc
	}
	if it.Workspace == "" || it.Ref == "" {
		return errBad("say which workspace, and which task (its key) or page (its id)")
	}
	f, err := os.Open(bk.Location)
	if err != nil {
		return errNotFound("backup file")
	}
	defer f.Close()
	rid, err := backup.RestoreItem(ctx, s.st, s.fileStore(), f, it)
	if err != nil {
		return &engine.Error{Code: engine.CodeNotFound, Message: err.Error()}
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("slug", it.Workspace), store.Live); err != nil {
		return errNotFound("workspace " + it.Workspace)
	}
	// Tell open browsers, and put the text back in the search index.
	if err := s.eng.AnnounceRestored(ctx, ws.ID, it.Kind, rid); err != nil {
		return err
	}
	s.eng.Reindex(ctx, ws.ID)
	s.audit(x.r, ws.ID, x.user, it.Kind+".restored_from_backup", it.Kind, rid, map[string]string{"backup": bk.ID, "ref": it.Ref})
	return x.ok(map[string]any{"restored": it.Kind, "id": rid, "workspace": ws.Slug})
}
