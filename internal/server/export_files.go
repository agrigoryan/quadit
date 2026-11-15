package server

import (
	"archive/zip"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
)

// files/ of an export: the uploaded files as they were uploaded.

// notIncludedName is the entry of files/ that names the uploaded files the
// export could not include, so whoever opens it knows it is incomplete.
const notIncludedName = "files/NOT-INCLUDED.txt"

// files writes files/: as uploaded. A file whose stored bytes cannot be
// opened is left out, named in notIncludedName, and the rest still go in.
func (e *exporter) files(rows *exportRows) error {
	var missing []string
	for _, f := range rows.files {
		if f.State != core.FileReady {
			continue
		}
		name := "files/" + f.ID + "/" + fileSafe(f.Name)
		r, _, err := e.uploads.Open(e.ctx, f.StorageKey)
		if err != nil {
			e.who.log.Warn("export: a file was not included", "file", f.ID, "err", err)
			missing = append(missing, name+": "+notIncludedWhy(err))
			continue
		}
		w, err := e.zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store, Modified: time.UnixMilli(f.CreatedAt)})
		if err == nil {
			_, err = io.Copy(w, r)
		}
		r.Close()
		if err != nil {
			return err
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return e.addTextFile(notIncludedName, "These uploaded files are not in this export:\n\n"+strings.Join(missing, "\n")+"\n")
}

// notIncludedWhy says, without naming anything on the server, why a file's
// stored bytes could not be opened.
func notIncludedWhy(err error) string {
	if errors.Is(err, blob.ErrNotFound) {
		return "its stored bytes are missing"
	}
	return "its stored bytes could not be read"
}
