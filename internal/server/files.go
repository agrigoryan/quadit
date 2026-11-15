package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

const defaultMaxUpload = 250 << 20 // clips up to 100 MB fit with room to spare

func (s *Server) maxUpload(ctx context.Context) int64 {
	if n := s.settingInt(ctx, "files.max_mb", 0); n > 0 {
		return int64(n) << 20
	}
	return defaultMaxUpload
}

func (s *Server) partPath(fileID string) string {
	return filepath.Join(s.cfg.DataDir, "uploads", fileID+".part")
}

// partKey is where one part of an upload that comes in several requests
// waits, in file storage, so the next part can reach any server.
func partKey(f core.File, offset int64) string {
	return fmt.Sprintf("%s.parts/%020d", f.StorageKey, offset)
}

// counter counts what is read through it.
type counter struct {
	r io.Reader
	n int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// gather puts the parts of an upload together into one local file, in
// order, and removes them from file storage.
func (s *Server) gather(ctx context.Context, f core.File) error {
	var keys []string
	if err := s.fileStore().List(ctx, f.StorageKey+".parts/", func(key string, _ int64) error { keys = append(keys, key); return nil }); err != nil {
		return err
	}
	if len(keys) == 0 {
		return nil
	}
	sort.Strings(keys)
	if err := os.MkdirAll(filepath.Dir(s.partPath(f.ID)), 0o750); err != nil {
		return err
	}
	out, err := os.Create(s.partPath(f.ID))
	if err != nil {
		return err
	}
	defer out.Close()
	for _, key := range keys {
		in, _, err := s.fileStore().Open(ctx, key)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		if err != nil {
			return err
		}
	}
	for _, key := range keys {
		s.fileStore().Delete(ctx, key)
	}
	return nil
}

// handleUploadFile stores a file. The body is the file itself (name it with ?name=),
// or a multipart form with a "file" field. A large file can come in parts:
// give its full size with ?size= and send the rest with PATCH.
func (s *Server) handleUploadFile(x *c) error {
	if x.actor.ReadOnly {
		return errForbidden("this credential is read-only")
	}
	ctx := x.ctx()
	maxSize := s.maxUpload(ctx)
	v := x.r.URL.Query()
	name, ctype := v.Get("name"), x.r.Header.Get("Content-Type")
	var src io.Reader = x.r.Body
	if strings.HasPrefix(ctype, "multipart/form-data") {
		mr, err := x.r.MultipartReader()
		if err != nil {
			return errBad("multipart: %v", err)
		}
		for {
			part, err := mr.NextPart()
			if err != nil {
				return errBad("the form has no \"file\" field")
			}
			if part.FormName() == "file" {
				if name == "" {
					name = part.FileName()
				}
				src, ctype = part, part.Header.Get("Content-Type")
				break
			}
		}
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "" || name == "." || name == "/" {
		return errBad("give the file a name: ?name=clip.mp4")
	}
	size := int64(x.intParam("size", 0))
	if size > maxSize {
		return errBad("files can be up to %d MB; this one is %d MB", maxSize>>20, size>>20)
	}
	// The caller may name the file's id itself (?id=): if the answer to this
	// first request is lost, asking for that file says how far it got, and
	// starting again with the same id does not make a second one.
	fid := v.Get("id")
	if fid != "" {
		if !looksUUID(fid) {
			return errBad("id must be a UUID made by the caller")
		}
		var had core.File
		if err := x.db.Get(ctx, &had, store.Eq("id", fid)); err == nil {
			if had.UploadedBy != x.member.UserID {
				return &engine.Error{Code: engine.CodeConflict, Message: "that file id is taken"}
			}
			return x.ok(s.fileOut(x, had))
		}
	} else {
		fid = id.New()
	}
	f := core.File{ID: fid, WorkspaceID: x.ws.ID, Name: name, ContentType: ctype, Size: size, State: "uploading",
		UploadedBy: x.member.UserID, CreatedAt: time.Now().UnixMilli()}
	f.StorageKey = x.ws.ID + "/" + f.ID
	if err := os.MkdirAll(filepath.Dir(s.partPath(f.ID)), 0o750); err != nil {
		return err
	}
	out, err := os.Create(s.partPath(f.ID))
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(src, maxSize+1))
	out.Close()
	if err != nil {
		os.Remove(s.partPath(f.ID))
		return errBad("upload interrupted: %v", err)
	}
	if n > maxSize {
		os.Remove(s.partPath(f.ID))
		return errBad("files can be up to %d MB", maxSize>>20)
	}
	f.Received = n
	if size == 0 {
		f.Size = n
	}
	if f.Received < f.Size {
		// More is to come, perhaps to another server: the first part waits
		// in file storage, not on this machine.
		in, err := os.Open(s.partPath(f.ID))
		if err != nil {
			return err
		}
		err = s.fileStore().Put(ctx, partKey(f, 0), in, "application/octet-stream")
		in.Close()
		os.Remove(s.partPath(f.ID))
		if err != nil {
			return fmt.Errorf("file storage: %w", err)
		}
	}
	if err := x.db.Insert(ctx, f); err != nil {
		return err
	}
	if f.Received >= f.Size {
		if err := s.finishUpload(ctx, x, &f); err != nil {
			return err
		}
	}
	return x.json(201, s.fileOut(x, f))
}

// handleUploadFilePart appends the next part of a file. offset must be where the
// last part ended; the answer says how much has arrived, so a broken upload
// resumes from there.
func (s *Server) handleUploadFilePart(x *c) error {
	ctx := x.ctx()
	var f core.File
	if err := x.db.Get(ctx, &f, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("file")
	}
	if f.State != "uploading" {
		return x.ok(s.fileOut(x, f))
	}
	if f.UploadedBy != x.member.UserID {
		return errForbidden("only the one who started an upload can continue it")
	}
	offset := int64(x.intParam("offset", -1))
	if offset != f.Received {
		return &httpError{Status: 409, Code: "conflict", Message: fmt.Sprintf("offset %d does not match the %d bytes received; continue from %d", offset, f.Received, f.Received)}
	}
	body := &counter{r: io.LimitReader(x.r.Body, f.Size-f.Received+1)}
	err := s.fileStore().Put(ctx, partKey(f, offset), body, "application/octet-stream")
	n := body.n
	if err != nil {
		// A part cut short is not kept: the caller sends it again from the
		// same place, which is what the answer tells it.
		s.fileStore().Delete(ctx, partKey(f, offset))
		return errBad("upload interrupted after %d bytes; continue from %d: %v", f.Received, f.Received, err)
	}
	if f.Received+n > f.Size {
		s.fileStore().Delete(ctx, partKey(f, offset))
		return errBad("more bytes than the size given when the upload started")
	}
	f.Received += n
	if _, uerr := x.db.Update(ctx, "files", map[string]any{"received": f.Received}, store.Eq("id", f.ID)); uerr != nil {
		return uerr
	}
	if f.Received == f.Size {
		if err := s.finishUpload(ctx, x, &f); err != nil {
			return err
		}
	}
	return x.ok(s.fileOut(x, f))
}

func (s *Server) fileOut(x *c, f core.File) core.File {
	if f.State == "ready" {
		f.URL, f.PreviewURL = x.fileURL(f)
	}
	return f
}

// finishUpload moves a complete upload into file storage, with its
// checksum, real type, size on screen and a reduced copy.
func (s *Server) finishUpload(ctx context.Context, x *c, f *core.File) error {
	path := s.partPath(f.ID)
	defer os.Remove(path)
	if err := s.gather(ctx, *f); err != nil {
		return fmt.Errorf("file storage: %w", err)
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(in, head)
	sniffed := http.DetectContentType(head[:n])
	if f.ContentType == "" || f.ContentType == "application/octet-stream" || strings.HasPrefix(f.ContentType, "multipart/") {
		f.ContentType = sniffed
		if byExt := mime.TypeByExtension(filepath.Ext(f.Name)); byExt != "" && (sniffed == "application/octet-stream" || strings.HasPrefix(sniffed, "text/plain")) {
			f.ContentType = byExt
		}
	}
	if i := strings.Index(f.ContentType, ";"); i > 0 && !strings.HasPrefix(f.ContentType, "text/") {
		f.ContentType = f.ContentType[:i]
	}
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return err
	}
	h := sha256.New()
	if err := s.fileStore().Put(ctx, f.StorageKey, io.TeeReader(in, h), f.ContentType); err != nil {
		return fmt.Errorf("file storage: %w", err)
	}
	f.SHA256, f.State = hex.EncodeToString(h.Sum(nil)), "ready"
	set := map[string]any{"state": "ready", "sha256": f.SHA256, "content_type": f.ContentType, "size": f.Size, "received": f.Size}
	switch {
	case strings.HasPrefix(f.ContentType, "image/") && f.ContentType != "image/svg+xml":
		if w, hgt, prev := imagePreview(path); w > 0 {
			f.Width, f.Height = w, hgt
			set["width"], set["height"] = w, hgt
			if prev != nil {
				f.PreviewKey = f.StorageKey + ".preview"
				if err := s.fileStore().Put(ctx, f.PreviewKey, bytes.NewReader(prev), http.DetectContentType(prev)); err == nil {
					set["preview_key"] = f.PreviewKey
				} else {
					f.PreviewKey = ""
				}
			}
		}
	case strings.HasPrefix(f.ContentType, "video/"):
		if w, hgt, ms, sheet := videoSheet(ctx, path); ms > 0 {
			f.Width, f.Height, f.DurationMS = w, hgt, ms
			set["width"], set["height"], set["duration_ms"] = w, hgt, ms
			if sheet != nil {
				f.PreviewKey = f.StorageKey + ".preview"
				if err := s.fileStore().Put(ctx, f.PreviewKey, bytes.NewReader(sheet), "image/jpeg"); err == nil {
					set["preview_key"] = f.PreviewKey
				} else {
					f.PreviewKey = ""
				}
			}
		}
	}
	_, err = x.db.Update(ctx, "files", set, store.Eq("id", f.ID))
	return err
}

const previewEdge = 720

// imagePreview returns an image's size and, when it is larger than a
// preview would be, a reduced copy. Small images, pixel art among them, are
// left alone so they stay sharp.
func imagePreview(path string) (w, h int, preview []byte) {
	in, err := os.Open(path)
	if err != nil {
		return 0, 0, nil
	}
	defer in.Close()
	cfg, format, err := image.DecodeConfig(in)
	if err != nil {
		return 0, 0, nil
	}
	w, h = cfg.Width, cfg.Height
	if (w <= previewEdge && h <= previewEdge) || w*h > 60_000_000 {
		return w, h, nil
	}
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return w, h, nil
	}
	img, _, err := image.Decode(in)
	if err != nil {
		return w, h, nil
	}
	scale := float64(previewEdge) / float64(max(w, h))
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(w)*scale)), max(1, int(float64(h)*scale))))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
	var buf bytes.Buffer
	if format == "png" || format == "gif" || format == "webp" {
		err = png.Encode(&buf, dst) // may have transparency
	} else {
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 84})
	}
	if err != nil {
		return w, h, nil
	}
	return w, h, buf.Bytes()
}

// videoSheet returns a clip's size and length and a sheet of nine stills,
// so an agent can look at a clip as one small image. It needs ffmpeg on the
// server; without it a clip simply has no sheet.
func videoSheet(ctx context.Context, path string) (w, h int, durationMS int64, sheet []byte) {
	ffprobe, err1 := exec.LookPath("ffprobe")
	ffmpeg, err2 := exec.LookPath("ffmpeg")
	if err1 != nil || err2 != nil {
		return 0, 0, 0, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
		"-of", "default=noprint_wrappers=1", path).Output()
	if err != nil {
		return 0, 0, 0, nil
	}
	var seconds float64
	for _, line := range strings.Split(string(out), "\n") {
		k, v, _ := strings.Cut(strings.TrimSpace(line), "=")
		switch k {
		case "width":
			w, _ = strconv.Atoi(v)
		case "height":
			h, _ = strconv.Atoi(v)
		case "duration":
			seconds, _ = strconv.ParseFloat(v, 64)
		}
	}
	if seconds <= 0 {
		return w, h, 0, nil
	}
	durationMS = int64(seconds * 1000)
	tmp, err := os.CreateTemp("", "quadit-sheet-*.jpg")
	if err != nil {
		return w, h, durationMS, nil
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	fps := 9 / seconds
	err = exec.CommandContext(ctx, ffmpeg, "-y", "-v", "error", "-i", path, "-vf", fmt.Sprintf("fps=%.6f,scale=360:-2,tile=3x3", fps),
		"-frames:v", "1", "-q:v", "4", tmp.Name()).Run()
	if err != nil {
		return w, h, durationMS, nil
	}
	sheet, _ = os.ReadFile(tmp.Name())
	return w, h, durationMS, sheet
}

func (s *Server) handleShowFile(x *c) error {
	var f core.File
	if err := x.db.Get(x.ctx(), &f, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("file")
	}
	if !s.maySeeFile(x, f) {
		return errNotFound("file")
	}
	return x.ok(s.fileOut(x, f))
}

// inlineTypes may be shown in the browser; everything else downloads.
func inlineType(ct string) bool {
	return strings.HasPrefix(ct, "image/") && ct != "image/svg+xml" || strings.HasPrefix(ct, "video/") || strings.HasPrefix(ct, "audio/") ||
		ct == "application/pdf" || strings.HasPrefix(ct, "text/plain")
}

// handleServeFile sends a file's bytes, or with /preview its reduced copy. The
// address never changes and neither do the bytes, so browsers keep them;
// ranges work, so a clip can be scrubbed without downloading it whole.
func (s *Server) handleServeFile(x *c) error {
	ctx := x.ctx()
	var f core.File
	if err := s.st.Get(ctx, &f, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil || f.State != "ready" {
		return errNotFound("file")
	}
	if n, err := s.st.Count(ctx, "members", store.Eq("workspace_id", f.WorkspaceID), store.Eq("user_id", x.user.ID), store.Null("removed_at"),
		store.Null("suspended_at")); err != nil || n == 0 {
		return errNotFound("file")
	}
	if x.token != nil && x.token.WorkspaceID != f.WorkspaceID {
		return errNotFound("file")
	}
	if !s.maySeeFile(x, f) {
		return errNotFound("file")
	}
	key, ctype, name := f.StorageKey, f.ContentType, f.Name
	if x.r.PathValue("name") == "preview" && x.r.URL.Query().Get("o") == "" {
		if f.PreviewKey == "" {
			if !strings.HasPrefix(f.ContentType, "image/") {
				return errNotFound("preview")
			}
		} else {
			key, ctype, name = f.PreviewKey, "", "preview-"+f.Name
		}
	}
	rd, mod, err := s.fileStore().Open(ctx, key)
	if errors.Is(err, blob.ErrNotFound) {
		return errNotFound("file contents")
	}
	if err != nil {
		return err
	}
	defer rd.Close()
	if ctype == "" {
		head := make([]byte, 512)
		n, _ := io.ReadFull(rd, head)
		ctype = http.DetectContentType(head[:n])
		rd.Seek(0, io.SeekStart)
	}
	h := x.w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	h.Set("ETag", `"`+f.ID+filepath.Ext(key)+`"`)
	// A file is never trusted to run as a page of this site.
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	disp := "attachment"
	if inlineType(ctype) && !truthyParam(x.r.URL.Query(), "download") {
		disp = "inline"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": name}))
	http.ServeContent(x.w, x.r, "", mod, rd)
	return nil
}

// looksUUID reports whether s has the shape of a lower-case UUID.
func looksUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch {
		case i == 8 || i == 13 || i == 18 || i == 23:
			if r != '-' {
				return false
			}
		case (r < '0' || r > '9') && (r < 'a' || r > 'f'):
			return false
		}
	}
	return true
}

// maySeeFile reports whether a member limited to some projects, or to
// reading with a token for some projects, may have a file: it is theirs, or
// it is attached to a task of a project they are in, or to a page they can
// see. A member with no limit sees every file of the workspace.
func (s *Server) maySeeFile(x *c, f core.File) bool {
	ctx := x.ctx()
	db := s.st.In(f.WorkspaceID)
	var m core.Member
	if err := db.Get(ctx, &m, store.Eq("user_id", x.user.ID), store.Null("removed_at")); err != nil {
		return false
	}
	var allowed []string
	if m.Scope != nil {
		allowed = m.Scope.Projects
	}
	if x.token != nil {
		var mine []string
		for _, sc := range strings.Fields(x.token.Scopes) {
			if p, ok := strings.CutPrefix(sc, "project:"); ok {
				mine = append(mine, p)
			}
		}
		if len(mine) > 0 {
			if len(allowed) == 0 {
				allowed = mine
			} else {
				allowed = keep(allowed, func(p string) bool { return has(mine, p) })
				if len(allowed) == 0 {
					allowed = []string{"none"}
				}
			}
		}
	}
	var atts []core.Attachment
	if err := db.List(ctx, &atts, store.Where(store.Eq("file_id", f.ID))); err != nil {
		return false
	}
	// A page's own files follow the page: a private page's are private.
	for _, a := range atts {
		if a.TaskID == "" && a.SubjectID != "" {
			var d core.Doc
			if db.Get(ctx, &d, store.Eq("id", a.SubjectID)) == nil && !engine.CanSeeDoc(d, x.user.ID) && f.UploadedBy != x.user.ID {
				return false
			}
		}
	}
	if len(allowed) == 0 || f.UploadedBy == x.user.ID {
		return true
	}
	for _, a := range atts {
		if a.TaskID != "" {
			var t core.Task
			if db.Get(ctx, &t, store.Eq("id", a.TaskID)) == nil && has(allowed, t.ProjectID) {
				return true
			}
			continue
		}
		var d core.Doc
		if db.Get(ctx, &d, store.Eq("id", a.SubjectID)) == nil && (d.ProjectID == "" || has(allowed, d.ProjectID)) {
			return true
		}
	}
	return false
}
