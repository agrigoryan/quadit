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
	"io/fs"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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

// partPath is where the bytes of an upload sent in one request wait on
// this machine until the file is stored: kept there when storing it
// fails, so that asking again finishes it.
func (s *Server) partPath(fileID string) string {
	return filepath.Join(s.cfg.DataDir, "uploads", fileID+".part")
}

// partKey is a new key for one part of an upload that comes in several
// requests, which waits in file storage so the next part can reach any
// server. Each part sent gets a key of its own, so one sent at the same
// time as another for the same place never writes over the one kept.
func partKey(f core.File, offset int64) string {
	return fmt.Sprintf("%s.parts/%020d-%s", f.StorageKey, offset, id.New())
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
// give its full size with ?size= and send the rest with PATCH. Given its
// checksum (?sha256=, in hex), the file is made ready only if its bytes
// match it.
func (s *Server) handleUploadFile(x *c) error {
	if err := x.mayWrite(); err != nil {
		return err
	}
	ctx := x.ctx()
	maxSize := s.maxUpload(ctx)
	up, err := readUploadStart(x)
	if err != nil {
		return err
	}
	q := x.r.URL.Query()
	sized := q.Get("size") != ""
	var size int64
	if sized {
		if size, err = strconv.ParseInt(q.Get("size"), 10, 64); err != nil || size < 0 {
			return errBad("size must be the file's size in bytes")
		}
	}
	if size > maxSize {
		return errBad("files can be up to %d MB; this one is %d MB", maxSize>>20, size>>20)
	}
	sum := strings.ToLower(q.Get("sha256"))
	if raw, err := hex.DecodeString(sum); sum != "" && (err != nil || len(raw) != sha256.Size) {
		return errBad("sha256 must be the file's SHA-256 checksum, in hex")
	}
	// The caller may name the file's id itself (?id=): if the answer to this
	// first request is lost, asking for that file says how far it got, and
	// starting again with the same id does not make a second one. Going on
	// needs the size the upload ends at.
	fid := q.Get("id")
	if fid == "" {
		fid = id.New()
	} else {
		if !id.Valid(fid) {
			return errBad("id must be a UUID made by the caller")
		}
		if !sized {
			return errBad("give the file's size (?size=) with an id of your own, so that the upload can go on from where it stops")
		}
		if had, there, err := s.ownUpload(x, fid); err != nil || there {
			if err != nil {
				return err
			}
			return s.startedAgain(x, had)
		}
	}
	// The row is made before a byte is taken, and it is what makes this
	// request the one that receives the upload's first part: another first
	// request under the same id that comes meanwhile finds the row and is
	// told how far the upload has got, as a retry would be.
	f := core.File{ID: fid, WorkspaceID: x.ws.ID, Name: up.name, ContentType: up.ctype, Size: size, SHA256: sum, State: core.FileUploading,
		UploadedBy: x.member.UserID, CreatedAt: time.Now().UnixMilli()}
	f.StorageKey = x.ws.ID + "/" + f.ID
	if err := x.db.Insert(ctx, f); err != nil {
		if !errors.Is(err, store.ErrConflict) || q.Get("id") == "" {
			return err
		}
		had, there, err := s.ownUpload(x, fid)
		if err != nil {
			return err
		}
		if !there {
			// The request whose row it was gave up between the two looks.
			return &httpError{Status: 409, Code: "conflict", Message: "another first request under this id was just given up; send this one again"}
		}
		return s.startedAgain(x, had)
	}
	kept, err := s.receiveFirstPart(ctx, x.db, &f, up.src, sized, maxSize)
	if err != nil {
		return err
	}
	if !kept {
		return x.ok(s.fileOut(x, f))
	}
	if f.Received == f.Size {
		if err := s.finishUpload(ctx, x, &f); err != nil {
			return err
		}
	}
	return x.json(201, s.fileOut(x, f))
}

// ownUpload finds the file a caller named by its own id, when a first
// request with that id came before; it is the caller's own or the id is
// taken.
func (s *Server) ownUpload(x *c, fid string) (core.File, bool, error) {
	var had core.File
	there, err := store.Find(x.ctx(), x.db, &had, store.Eq("id", fid))
	if err != nil || !there {
		return had, false, err
	}
	if had.UploadedBy != x.member.UserID {
		return had, false, &engine.Error{Code: engine.CodeConflict, Message: "that file id is taken", Reason: engine.ReasonInUse}
	}
	return had, true, nil
}

// startedAgain answers a first request under the id of an upload that
// was started before with the upload as it stands, which the caller goes
// on from. One whose bytes all came but could not be stored is finished
// now.
func (s *Server) startedAgain(x *c, f core.File) error {
	if f.State == core.FileUploading && f.Received == f.Size {
		if err := s.finishUpload(x.ctx(), x, &f); err != nil {
			return err
		}
	}
	return x.ok(s.fileOut(x, f))
}

// receiveFirstPart takes in what the first request of an upload carries,
// for the row f made for it, and says whether it was kept. The whole file
// waits on this machine (partPath); the first of several parts waits in
// file storage instead, where the next part may be sent from any server.
// Either is kept only if nothing came for the upload since the row was
// made (another caller may have gone on from its start meanwhile);
// otherwise f is the upload as it stands. Bytes are counted as they
// arrive, never more than the size given, or the largest file taken. A
// first part with no bytes stores nothing: the upload is kept at 0.
//
// A request that fails takes its row away with it, unless bytes came for
// the upload meanwhile, so that a first request sent again starts afresh.
func (s *Server) receiveFirstPart(ctx context.Context, db store.DB, f *core.File, src io.Reader, sized bool, maxSize int64) (kept bool, err error) {
	defer func() {
		if err != nil {
			if _, derr := db.Delete(ctx, "files", store.Eq("id", f.ID), store.Eq("state", core.FileUploading), store.Eq("received", 0)); derr != nil {
				s.log.Warn("upload: removing the row of one that brought nothing", "file", f.ID, "err", derr)
			}
		}
	}()
	dir := filepath.Dir(s.partPath(f.ID))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return false, err
	}
	// A file of this request's own: another request for the same upload
	// never writes into it, nor removes it.
	out, err := os.CreateTemp(dir, f.ID+".*.receiving")
	if err != nil {
		return false, err
	}
	defer os.Remove(out.Name()) // gone once moved or stored; a leftover after a failure
	limit := maxSize
	if sized {
		limit = f.Size
	}
	n, err := io.Copy(out, io.LimitReader(src, limit+1))
	cerr := out.Close()
	switch {
	case err != nil:
		return false, errBad("upload interrupted: %v", err)
	case cerr != nil:
		// What was received did not all reach the disk.
		return false, fmt.Errorf("saving the upload: %w", cerr)
	case n > limit && sized:
		return false, errBad("more bytes than the size given (%d)", f.Size)
	case n > limit:
		return false, errBad("files can be up to %d MB", maxSize>>20)
	}
	if !sized {
		f.Size = n
	}
	set := map[string]any{"received": n, "size": f.Size}
	received := core.File{ID: f.ID}
	switch {
	case n == f.Size:
		err = os.Rename(out.Name(), s.partPath(f.ID))
	case n > 0:
		received.Parts = []string{partKey(*f, 0)}
		set["parts"] = received.Parts
		if err = s.putLocal(ctx, received.Parts[0], out.Name()); err != nil {
			err = fmt.Errorf("file storage: %w", err)
		}
	}
	if err == nil {
		var changed int64
		if changed, err = db.Update(ctx, "files", set, store.Eq("id", f.ID), store.Eq("state", core.FileUploading), store.Eq("received", 0)); err == nil && changed == 0 {
			s.dropReceived(ctx, received)
			return false, db.Get(ctx, f, store.Eq("id", f.ID))
		}
	}
	if err != nil {
		s.dropReceived(ctx, received)
		return false, err
	}
	f.Received, f.Parts = n, received.Parts
	return true, nil
}

// putLocal stores the file at path in file storage under key.
func (s *Server) putLocal(ctx context.Context, key, path string) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	return s.fileStore().Put(ctx, key, in, "application/octet-stream")
}

// handleUploadFilePart appends the next part of a file. offset must be where the
// last part ended; the answer says how much has arrived, so a broken upload
// resumes from there. An upload whose bytes all came but could not be
// stored is finished by sending nothing from its end.
func (s *Server) handleUploadFilePart(x *c) error {
	if err := x.mayWrite(); err != nil {
		return err
	}
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
		return offsetConflict(offset, f.Received)
	}
	if f.Received < f.Size {
		// The part is written under a key of its own, then kept only if no
		// other part was kept for the same place meanwhile: the count of
		// bytes and the list of parts change together, and only from where
		// this part began.
		key := partKey(f, offset)
		body := &counter{r: io.LimitReader(x.r.Body, f.Size-f.Received+1)}
		err := s.fileStore().Put(ctx, key, body, "application/octet-stream")
		if err != nil {
			// A part cut short is not kept: the caller sends it again from the
			// same place, which is what the answer tells it.
			s.dropParts(ctx, key)
			if errors.Is(err, blob.ErrUnusable) {
				return err // answered "try again later", not as a request sent wrong
			}
			return errBad("upload interrupted after %d bytes; continue from %d: %v", f.Received, f.Received, err)
		}
		if f.Received+body.n > f.Size {
			s.dropParts(ctx, key)
			return errBad("more bytes than the size given when the upload started")
		}
		if body.n == 0 {
			// Nothing to keep, and nothing changes: the count stays where it
			// is, so a first request still arriving keeps its place.
			s.dropParts(ctx, key)
			return x.ok(s.fileOut(x, f))
		}
		parts := append(slices.Clip(f.Parts), key)
		n, err := x.db.Update(ctx, "files", map[string]any{"received": f.Received + body.n, "parts": parts},
			store.Eq("id", f.ID), store.Eq("state", core.FileUploading), store.Eq("received", f.Received))
		if err != nil || n == 0 {
			s.dropParts(ctx, key)
		}
		if err != nil {
			return err
		}
		if n == 0 {
			if err := x.db.Get(ctx, &f, store.Eq("id", f.ID)); err != nil {
				return err
			}
			return offsetConflict(offset, f.Received)
		}
		f.Received, f.Parts = f.Received+body.n, parts
	}
	if f.Received == f.Size {
		if err := s.finishUpload(ctx, x, &f); err != nil {
			return err
		}
	}
	return x.ok(s.fileOut(x, f))
}

// offsetConflict is the refusal of a part sent for another place than
// where the upload has got to.
func offsetConflict(offset, received int64) error {
	return &httpError{Status: 409, Code: "conflict", Message: fmt.Sprintf("offset %d does not match the %d bytes received; continue from %d", offset, received, received)}
}

// dropParts removes parts from file storage that are not, or no longer,
// needed. One left behind is never read: only the parts a file lists are.
func (s *Server) dropParts(ctx context.Context, keys ...string) {
	for _, key := range keys {
		if err := s.fileStore().Delete(ctx, key); err != nil {
			s.log.Warn("upload: removing a part that is not needed", "key", key, "err", err)
		}
	}
}

// dropReceived removes what an upload received, once it is stored or
// will not be.
func (s *Server) dropReceived(ctx context.Context, f core.File) {
	s.dropParts(ctx, f.Parts...)
	if err := os.Remove(s.partPath(f.ID)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		s.log.Warn("upload: removing what was received", "file", f.ID, "err", err)
	}
}

// fileOut is a file as the API shows it: with its addresses once it is ready.
func (s *Server) fileOut(x *c, f core.File) core.File {
	if f.State == core.FileReady {
		f.URL, f.PreviewURL = x.fileURL(f)
	}
	return f
}

// finishUpload stores a complete upload whole in file storage, with its
// checksum, real type, size on screen and a reduced copy, and marks it
// ready. The bytes put together must be the file the upload was started
// as: as many as its size, and matching the checksum given, if one was;
// when they are not, a part listed is gone from file storage, or a file
// received whole is not on this machine, what was received is let go and
// the caller is told to send the file again from the start. What was received (the parts, or the file on this
// machine) is removed only once the file is stored and marked: until then
// a failure leaves it all, and finishing again starts from it.
func (s *Server) finishUpload(ctx context.Context, x *c, f *core.File) error {
	path := s.partPath(f.ID)
	if len(f.Parts) > 0 {
		joined, err := s.joinUploadParts(ctx, *f)
		if errors.Is(err, blob.ErrNotFound) {
			// Asking again does not bring a part back that is gone; one that
			// cannot be read for now may, and is asked for again instead.
			return s.startUploadOver(ctx, x.db, *f, "a part of this upload is no longer in file storage")
		}
		if err != nil {
			return fmt.Errorf("file storage: %w", err)
		}
		defer os.Remove(joined)
		path = joined
	}
	in, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		// Received whole by another server, or kept on a disk since lost: no
		// request here can finish it, and the caller cannot pick a server.
		return s.startUploadOver(ctx, x.db, *f, "this upload's bytes are not kept on this server")
	}
	if err != nil {
		return err
	}
	defer in.Close()
	h := sha256.New()
	n, err := io.Copy(h, in)
	if err != nil {
		return err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	switch {
	case n != f.Size:
		return s.startUploadOver(ctx, x.db, *f, fmt.Sprintf("the bytes kept add up to %d, not the %d the upload was started with", n, f.Size))
	case f.SHA256 != "" && sum != f.SHA256:
		return s.startUploadOver(ctx, x.db, *f, "the bytes received do not match the sha256 the upload was started with")
	}
	sniffed, err := sniffType(io.NewSectionReader(in, 0, sniffSize))
	if err != nil {
		return err
	}
	f.ContentType = settleType(f.ContentType, sniffed, f.Name)
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := s.fileStore().Put(ctx, f.StorageKey, in, f.ContentType); err != nil {
		return fmt.Errorf("file storage: %w", err)
	}
	ready := *f
	ready.SHA256, ready.State, ready.Parts = sum, core.FileReady, nil
	set := map[string]any{"state": core.FileReady, "sha256": ready.SHA256, "content_type": ready.ContentType, "size": ready.Size, "received": ready.Size, "parts": nil}
	s.addPreview(ctx, &ready, path, set)
	// Two requests may finish the same upload at once; the file is the same
	// bytes either way, and the first to mark it ready is the one that counts.
	// One whose upload was started over meanwhile (startUploadOver) stored
	// bytes the upload no longer stands for, under the key it had then: the
	// key fences it, so its late store cannot replace the bytes the new start
	// stores, and its row is not marked; what it received and stored is
	// removed.
	changed, err := x.db.Update(ctx, "files", set, store.Eq("id", f.ID), store.Eq("state", core.FileUploading), store.Eq("storage_key", f.StorageKey))
	if err != nil {
		return err
	}
	if changed == 0 {
		stale := *f
		if err := x.db.Get(ctx, f, store.Eq("id", f.ID)); err != nil {
			return err
		}
		if f.StorageKey != stale.StorageKey {
			in.Close()
			s.dropReceived(ctx, stale)
			s.dropParts(ctx, slices.DeleteFunc([]string{ready.StorageKey, ready.PreviewKey}, func(key string) bool { return key == "" })...)
		}
		return nil
	}
	in.Close()
	s.dropReceived(ctx, *f)
	*f = ready
	return nil
}

// startUploadOver lets go of what an upload received when it is not the
// file the upload was started as (why says how), and refuses the request
// with where to continue from: the start. The upload gets a new storage
// key, which is what tells a request still storing the old start apart
// from the new one (finishUpload).
func (s *Server) startUploadOver(ctx context.Context, db store.DB, f core.File, why string) error {
	fresh := fmt.Sprintf("%s/%s-%s", f.WorkspaceID, f.ID, id.New())
	changed, err := db.Update(ctx, "files", map[string]any{"received": 0, "parts": nil, "storage_key": fresh},
		store.Eq("id", f.ID), store.Eq("state", core.FileUploading), store.Eq("storage_key", f.StorageKey), store.Eq("received", f.Received))
	if err != nil {
		return err
	}
	if changed > 0 {
		s.dropReceived(ctx, f)
	}
	return &httpError{Status: 409, Code: "conflict", Message: why + "; send the file again: continue from 0"}
}

// joinUploadParts puts the parts an upload lists together, in order, into
// a new file on this machine, and gives its path. The parts stay where
// they are.
func (s *Server) joinUploadParts(ctx context.Context, f core.File) (string, error) {
	if err := os.MkdirAll(filepath.Dir(s.partPath(f.ID)), 0o750); err != nil {
		return "", err
	}
	out, err := os.CreateTemp(filepath.Dir(s.partPath(f.ID)), f.ID+".join-*")
	if err != nil {
		return "", err
	}
	for _, key := range f.Parts {
		if err = s.appendPart(ctx, out, key); err != nil {
			break
		}
	}
	// A write that fails only when the file is closed leaves it short.
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(out.Name())
		return "", err
	}
	return out.Name(), nil
}

// appendPart copies one part from file storage to out.
func (s *Server) appendPart(ctx context.Context, out io.Writer, key string) error {
	in, _, err := s.fileStore().Open(ctx, key)
	if err != nil {
		return err
	}
	defer in.Close()
	_, err = io.Copy(out, in)
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
// address never changes and neither do the bytes, so a browser may keep
// them, but it asks again (by the ETag) each time it shows them: who may
// see a file is checked on every showing, so a browser signed out, or of
// someone who lost access, shows nothing from its cache. Ranges work, so a
// clip can be scrubbed without downloading it whole.
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
	// caller entered into it as into any workspace. Not a member, or not
	// through this credential, the file is not there.
	var ws core.Workspace
	if there, err := store.Find(ctx, s.st, &ws, store.Eq("id", f.WorkspaceID), store.Live); err != nil || !there {
		return errNotFound("file")
	}
	if err := s.enter(ctx, x, ws); err != nil {
		if _, refused := errors.AsType[*engine.Error](err); refused {
			return errNotFound("file")
		}
		return err
	}
	if !x.canSeeFile(ctx, f) {
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
	h.Set("Cache-Control", "private, no-cache")
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
