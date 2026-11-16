package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // lets image.Decode read GIFs, for sizes and previews
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
	_ "golang.org/x/image/webp" // lets image.Decode read WebP, for sizes and previews

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Uploads: a file sent in one request or in parts, made ready with its
// checksum, type and preview, and served back to those who may see it.

const defaultMaxUpload = 250 << 20 // clips up to 100 MB fit with room to spare

// sniffSize is how much of a file is read to tell its type.
const sniffSize = 512

// maxUpload is the largest file the install takes, from the "files.max_mb" setting.
func (s *Server) maxUpload(ctx context.Context) int64 {
	if n := 0; s.settings.Get(ctx, "files.max_mb", &n) && n > 0 {
		return int64(n) << 20
	}
	return defaultMaxUpload
}

// partPath is where an upload is put together on this machine.
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

// Read reads from the reader underneath and counts what came.
func (c *counter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// joinUploadParts puts the parts of an upload together into one local file, in
// order, and removes them from file storage once the file is complete.
func (s *Server) joinUploadParts(ctx context.Context, f core.File) error {
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
	if err := s.appendParts(ctx, out, keys); err != nil {
		out.Close()
		return err
	}
	// A write that fails only when the file is closed leaves it short: the
	// parts are kept until it is whole.
	if err := out.Close(); err != nil {
		return err
	}
	for _, key := range keys {
		if err := s.fileStore().Delete(ctx, key); err != nil {
			s.log.Warn("upload: removing a part that was put together", "key", key, "err", err)
		}
	}
	return nil
}

// appendParts copies the parts named by keys, in order, to out.
func (s *Server) appendParts(ctx context.Context, out io.Writer, keys []string) error {
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
	return nil
}

// uploadStart is the first request of an upload: the file's bytes, or the
// first part of them, its name and its type as the caller gave them.
type uploadStart struct {
	src   io.Reader
	name  string
	ctype string
}

// readUploadStart finds the file in an upload request: the body itself,
// or the "file" field of a multipart form.
func readUploadStart(x *c) (uploadStart, error) {
	up := uploadStart{src: x.r.Body, name: x.r.URL.Query().Get("name"), ctype: x.r.Header.Get("Content-Type")}
	if strings.HasPrefix(up.ctype, "multipart/form-data") {
		mr, err := x.r.MultipartReader()
		if err != nil {
			return up, errBad("multipart: %v", err)
		}
		for {
			part, err := mr.NextPart()
			if err != nil {
				return up, errBad("the form has no \"file\" field")
			}
			if part.FormName() == "file" {
				if up.name == "" {
					up.name = part.FileName()
				}
				up.src, up.ctype = part, part.Header.Get("Content-Type")
				break
			}
		}
	}
	up.name = filepath.Base(strings.ReplaceAll(up.name, "\\", "/"))
	if up.name == "" || up.name == "." || up.name == "/" {
		return up, errBad("give the file a name: ?name=clip.mp4")
	}
	return up, nil
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
	up, err := readUploadStart(x)
	if err != nil {
		return err
	}
	size := int64(x.intParam("size", 0))
	if size > maxSize {
		return errBad("files can be up to %d MB; this one is %d MB", maxSize>>20, size>>20)
	}
	// The caller may name the file's id itself (?id=): if the answer to this
	// first request is lost, asking for that file says how far it got, and
	// starting again with the same id does not make a second one.
	fid := x.r.URL.Query().Get("id")
	if fid == "" {
		fid = id.New()
	} else {
		had, there, err := s.startedUpload(x, fid)
		if err != nil {
			return err
		}
		if there {
			return x.ok(s.fileOut(x, had))
		}
	}
	f := core.File{ID: fid, WorkspaceID: x.ws.ID, Name: up.name, ContentType: up.ctype, Size: size, State: core.FileUploading,
		UploadedBy: x.member.UserID, CreatedAt: time.Now().UnixMilli()}
	f.StorageKey = x.ws.ID + "/" + f.ID
	if err := s.receiveFirstPart(ctx, &f, up.src, maxSize); err != nil {
		return err
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

// startedUpload finds the file a caller named by its own id, when a first
// request with that id came before; it is the caller's own or the id is
// taken.
func (s *Server) startedUpload(x *c, fid string) (core.File, bool, error) {
	var had core.File
	if !id.Valid(fid) {
		return had, false, errBad("id must be a UUID made by the caller")
	}
	there, err := store.Find(x.ctx(), x.db, &had, store.Eq("id", fid))
	if err != nil || !there {
		return had, false, err
	}
	if had.UploadedBy != x.member.UserID {
		return had, false, &engine.Error{Code: engine.CodeConflict, Message: "that file id is taken", Reason: engine.ReasonInUse}
	}
	return had, true, nil
}

// receiveFirstPart writes what the first request of an upload carries to
// this machine and sets how much arrived. When more is to come, perhaps to
// another server, the part waits in file storage instead.
func (s *Server) receiveFirstPart(ctx context.Context, f *core.File, src io.Reader, maxSize int64) error {
	if err := os.MkdirAll(filepath.Dir(s.partPath(f.ID)), 0o750); err != nil {
		return err
	}
	out, err := os.Create(s.partPath(f.ID))
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(src, maxSize+1))
	cerr := out.Close()
	if err != nil {
		os.Remove(s.partPath(f.ID))
		return errBad("upload interrupted: %v", err)
	}
	if cerr != nil {
		// What was received did not all reach the disk.
		os.Remove(s.partPath(f.ID))
		return fmt.Errorf("saving the upload: %w", cerr)
	}
	if n > maxSize {
		os.Remove(s.partPath(f.ID))
		return errBad("files can be up to %d MB", maxSize>>20)
	}
	f.Received = n
	if f.Size == 0 {
		f.Size = n
	}
	if f.Received >= f.Size {
		return nil
	}
	in, err := os.Open(s.partPath(f.ID))
	if err != nil {
		return err
	}
	err = s.fileStore().Put(ctx, partKey(*f, 0), in, "application/octet-stream")
	in.Close()
	os.Remove(s.partPath(f.ID))
	if err != nil {
		return fmt.Errorf("file storage: %w", err)
	}
	return nil
}

// handleUploadFilePart appends the next part of a file. offset must be where the
// last part ended; the answer says how much has arrived, so a broken upload
// resumes from there.
func (s *Server) handleUploadFilePart(x *c) error {
	ctx := x.ctx()
	var f core.File
	if err := x.db.Get(ctx, &f, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return err
	}
	if f.State != core.FileUploading {
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
		s.dropPart(ctx, f, offset)
		return errBad("upload interrupted after %d bytes; continue from %d: %v", f.Received, f.Received, err)
	}
	if f.Received+n > f.Size {
		s.dropPart(ctx, f, offset)
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

// dropPart removes a part that is not kept. One left behind is written over
// when the part is sent again.
func (s *Server) dropPart(ctx context.Context, f core.File, offset int64) {
	if err := s.fileStore().Delete(ctx, partKey(f, offset)); err != nil {
		s.log.Warn("upload: removing a part that is not kept", "file", f.ID, "err", err)
	}
}

// fileOut is a file as the API shows it: with its addresses once it is ready.
func (s *Server) fileOut(x *c, f core.File) core.File {
	if f.State == core.FileReady {
		f.URL, f.PreviewURL = x.fileURL(f)
	}
	return f
}

// finishUpload moves a complete upload into file storage, with its
// checksum, real type, size on screen and a reduced copy.
func (s *Server) finishUpload(ctx context.Context, x *c, f *core.File) error {
	path := s.partPath(f.ID)
	defer os.Remove(path)
	if err := s.joinUploadParts(ctx, *f); err != nil {
		return fmt.Errorf("file storage: %w", err)
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	sniffed, err := sniffType(in)
	if err != nil {
		return err
	}
	f.ContentType = settleType(f.ContentType, sniffed, f.Name)
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return err
	}
	h := sha256.New()
	if err := s.fileStore().Put(ctx, f.StorageKey, io.TeeReader(in, h), f.ContentType); err != nil {
		return fmt.Errorf("file storage: %w", err)
	}
	f.SHA256, f.State = hex.EncodeToString(h.Sum(nil)), "ready"
	set := map[string]any{"state": core.FileReady, "sha256": f.SHA256, "content_type": f.ContentType, "size": f.Size, "received": f.Size}
	s.addPreview(ctx, f, path, set)
	_, err = x.db.Update(ctx, "files", set, store.Eq("id", f.ID))
	return err
}

// sniffType reads the start of r and says what type of content it holds.
func sniffType(r io.Reader) (string, error) {
	head := make([]byte, sniffSize)
	n, err := io.ReadFull(r, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return "", err
	}
	return http.DetectContentType(head[:n]), nil
}

// settleType decides a file's type: the one the caller gave, unless it says
// nothing, in which case what the bytes look like, or failing that what the
// name's extension says. Parameters are dropped except for text.
func settleType(given, sniffed, name string) string {
	ctype := given
	if ctype == "" || ctype == "application/octet-stream" || strings.HasPrefix(ctype, "multipart/") {
		ctype = sniffed
		if byExt := mime.TypeByExtension(filepath.Ext(name)); byExt != "" && (sniffed == "application/octet-stream" || strings.HasPrefix(sniffed, "text/plain")) {
			ctype = byExt
		}
	}
	if i := strings.Index(ctype, ";"); i > 0 && !strings.HasPrefix(ctype, "text/") {
		ctype = ctype[:i]
	}
	return ctype
}

// addPreview reads an image's or a clip's size, and length, and stores a
// reduced copy or a sheet of stills when there is one. What it finds goes
// on f and into set, the columns to write.
func (s *Server) addPreview(ctx context.Context, f *core.File, path string, set map[string]any) {
	var preview []byte
	var previewType string
	switch {
	case strings.HasPrefix(f.ContentType, "image/") && f.ContentType != "image/svg+xml":
		w, hgt, prev := imagePreview(path)
		if w <= 0 {
			return
		}
		f.Width, f.Height = w, hgt
		set["width"], set["height"] = w, hgt
		preview, previewType = prev, http.DetectContentType(prev)
	case strings.HasPrefix(f.ContentType, "video/"):
		v := videoSheet(ctx, path)
		if v.durationMS <= 0 {
			return
		}
		f.Width, f.Height, f.DurationMS = v.width, v.height, v.durationMS
		set["width"], set["height"], set["duration_ms"] = v.width, v.height, v.durationMS
		preview, previewType = v.sheet, "image/jpeg"
	}
	if preview == nil {
		return
	}
	f.PreviewKey = f.StorageKey + ".preview"
	if err := s.fileStore().Put(ctx, f.PreviewKey, bytes.NewReader(preview), previewType); err == nil {
		set["preview_key"] = f.PreviewKey
	} else {
		f.PreviewKey = ""
	}
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

// clipFacts is what videoSheet finds out about a clip.
type clipFacts struct {
	width, height int
	durationMS    int64
	sheet         []byte // nine stills on one image; nil without ffmpeg
}

// videoSheet returns a clip's size and length and a sheet of nine stills,
// so an agent can look at a clip as one small image. It needs ffmpeg on the
// server; without it a clip simply has no sheet.
func videoSheet(ctx context.Context, path string) clipFacts {
	var v clipFacts
	ffprobe, err1 := exec.LookPath("ffprobe")
	ffmpeg, err2 := exec.LookPath("ffmpeg")
	if err1 != nil || err2 != nil {
		return v
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
		"-of", "default=noprint_wrappers=1", path).Output()
	if err != nil {
		return v
	}
	// A value ffprobe gives that does not read counts as zero.
	var seconds float64
	for line := range strings.SplitSeq(string(out), "\n") {
		k, val, _ := strings.Cut(strings.TrimSpace(line), "=")
		switch k {
		case "width":
			v.width = atoiOrZero(val)
		case "height":
			v.height = atoiOrZero(val)
		case "duration":
			if f, err := strconv.ParseFloat(val, 64); err == nil {
				seconds = f
			}
		}
	}
	if seconds <= 0 {
		return v
	}
	v.durationMS = int64(seconds * 1000)
	tmp, err := os.CreateTemp("", "quadit-sheet-*.jpg")
	if err != nil {
		return v
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	fps := 9 / seconds
	err = exec.CommandContext(ctx, ffmpeg, "-y", "-v", "error", "-i", path, "-vf", fmt.Sprintf("fps=%.6f,scale=360:-2,tile=3x3", fps),
		"-frames:v", "1", "-q:v", "4", tmp.Name()).Run()
	if err != nil {
		return v
	}
	if sheet, err := os.ReadFile(tmp.Name()); err == nil {
		v.sheet = sheet
	}
	return v
}

// atoiOrZero reads a whole number, or zero when s is not one.
func atoiOrZero(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

// handleShowFile answers with a file's record, to those who may see it.
func (s *Server) handleShowFile(x *c) error {
	var f core.File
	if err := x.db.Get(x.ctx(), &f, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return err
	}
	if !x.canSeeFile(x.ctx(), f) {
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
	if err := s.st.Get(ctx, &f, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return err
	}
	if f.State != core.FileReady {
		return errNotFound("file")
	}
	// The route names no workspace: the file's own is found here, and the
	// caller read as the member of it that they are. Not a member, or not
	// through this token, the file is not there.
	var ws core.Workspace
	var member core.Member
	if there, err := store.Find(ctx, s.st, &ws, store.Eq("id", f.WorkspaceID)); err != nil || !there {
		return errNotFound("file")
	}
	if there, err := store.Find(ctx, s.st.In(ws.ID), &member, store.Eq("user_id", x.user.ID), store.Null("removed_at"), store.Null("suspended_at")); err != nil || !there {
		return errNotFound("file")
	}
	if x.token != nil && x.token.WorkspaceID != f.WorkspaceID {
		return errNotFound("file")
	}
	who := s.viewerFor(ws, member)
	if x.token != nil {
		who.limitTo(tokenProjects(x.token))
	}
	if !who.canSeeFile(ctx, f) {
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
		if ctype, err = sniffType(rd); err != nil {
			return err
		}
		if _, err := rd.Seek(0, io.SeekStart); err != nil {
			return err
		}
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

// canSeeFile reports whether the viewer may have a file. A private page's
// files are private, whoever asks, unless the viewer uploaded them. Beyond
// that a viewer with no limit sees every file of the workspace, and one
// limited to some projects sees a file that is its own, or attached to a
// task of a project it may read, or to a page it may see. A file on a
// comment on a page is the page's (attachmentPage). When what decides it
// cannot be read, the answer is no.
func (who *viewer) canSeeFile(ctx context.Context, f core.File) bool {
	var atts []core.Attachment
	if err := who.db.List(ctx, &atts, store.Where(store.Eq("file_id", f.ID))); err != nil {
		return false
	}
	me := who.member.UserID
	// A page's own files follow the page: a private page's are private.
	if f.UploadedBy != me && onHiddenPage(ctx, who.db, atts, me) {
		return false
	}
	if !who.limited() || f.UploadedBy == me {
		return true
	}
	for _, a := range atts {
		if a.TaskID != "" {
			var t core.Task
			if who.db.Get(ctx, &t, store.Eq("id", a.TaskID)) == nil && who.canProject(t.ProjectID) {
				return true
			}
			continue
		}
		if d, there, err := attachmentPage(ctx, who.db, a); err == nil && there && who.canProject(d.ProjectID) {
			return true
		}
	}
	return false
}

// attachmentPage finds the page an attachment on no task is shown on: the
// page itself, or the page of the comment it is on. there is false when it
// is on neither, or the page is gone for good.
func attachmentPage(ctx context.Context, db store.DB, a core.Attachment) (page core.Doc, there bool, err error) {
	pageID := a.SubjectID
	if a.SubjectType == "comment" {
		var comment core.Comment
		if there, err := store.Find(ctx, db, &comment, store.Eq("id", a.SubjectID)); err != nil || !there {
			return page, false, err
		}
		pageID = comment.DocID
	}
	if pageID == "" {
		return page, false, nil
	}
	there, err = store.Find(ctx, db, &page, store.Eq("id", pageID))
	return page, there, err
}

// onHiddenPage reports whether a file is attached to a page the user
// cannot see, or to one that cannot be read.
func onHiddenPage(ctx context.Context, db store.DB, atts []core.Attachment, userID string) bool {
	for _, a := range atts {
		if a.TaskID == "" && a.SubjectID != "" {
			d, there, err := attachmentPage(ctx, db, a)
			if err != nil || (there && !engine.CanSeeDoc(d, userID)) {
				return true // a page that cannot be read is taken to be one the user cannot see
			}
		}
	}
	return false
}
