package server

import (
	"os"
	"path/filepath"
	"strings"
)

// staysInside reports whether path is under dir with no symbolic link on
// the way there, is not a link itself, and has no plain file where one of
// its folders would be. A repository can hold links to
// anywhere: out of the checkout, or to another folder inside it. Sync
// neither reads nor writes through any of them, so a page is only ever
// stored in the file its own path names. A part of the path that does not
// exist yet is fine: it will be made as a real folder or file.
func staysInside(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	at := dir
	parts := strings.Split(rel, string(filepath.Separator))
	for i, part := range parts {
		if part == "" || part == "." {
			continue
		}
		at = filepath.Join(at, part)
		st, err := os.Lstat(at)
		if err != nil {
			return true // nothing there yet, so nothing below it either
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if i < len(parts)-1 && !st.IsDir() {
			return false // a file stands where a folder would have to be
		}
	}
	return true
}
