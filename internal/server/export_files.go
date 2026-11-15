package server

import (
	"archive/zip"
	"io"
	"time"
)

// files writes files/: as uploaded.
func (e *exporter) files() error {
	for _, f := range e.rows.files {
		if f.State != "ready" {
			continue
		}
		r, _, err := e.x.s.fileStore().Open(e.x.ctx(), f.StorageKey)
		if err != nil {
			continue
		}
		w, err := e.zw.CreateHeader(&zip.FileHeader{Name: "files/" + f.ID + "/" + fileSafe(f.Name), Method: zip.Store, Modified: time.UnixMilli(f.CreatedAt)})
		if err == nil {
			_, err = io.Copy(w, r)
		}
		r.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
