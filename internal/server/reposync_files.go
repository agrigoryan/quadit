package server

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// findFolder settles where in the working copy the source's pages are kept.
func (r *syncRun) findFolder() error {
	r.root = filepath.Join(r.dir, filepath.FromSlash(r.src.Subdir))
	// Whatever is stored, and whatever links the repository holds, nothing
	// outside the checkout is ever read or written.
	if !staysInside(r.dir, r.root) {
		return errors.New("the source's folder leads out of its repository, or goes through a link in it; set it to a real folder inside, such as docs")
	}
	if st, serr := os.Stat(r.root); r.src.Subdir != "" && serr == nil && !st.IsDir() {
		return errors.New("the source's folder " + r.src.Subdir + " is a file in the repository; set it to a folder")
	} else if r.src.Subdir != "" && serr != nil {
		// Said, and not the end of it: pages written here may be what
		// makes the folder.
		r.noFolder = "the repository has no folder " + r.src.Subdir + " on " + r.branch + " yet"
		r.say(r.noFolder)
	}
	return nil
}

// readFiles reads every Markdown file under the folder.
func (r *syncRun) readFiles() error {
	r.files = map[string]string{}
	return filepath.WalkDir(r.root, func(p string, e os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		name := e.Name()
		if e.Type()&os.ModeSymlink != 0 {
			return nil // a link may point anywhere on the server: it is not a page
		}
		if e.IsDir() {
			if p != r.root && (strings.HasPrefix(name, ".") || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(name), ".md") {
			if raw, rerr := os.ReadFile(p); rerr == nil && len(raw) < 2<<20 {
				rel, _ := filepath.Rel(r.root, p)
				r.files[filepath.ToSlash(rel)] = string(raw)
			}
		}
		return nil
	})
}

// taken reports whether a path under the folder cannot be given to a new
// file: a file has it, or a link or a folder stands on it.
func (r *syncRun) taken(p string) bool {
	// By being there, not by having text: an empty file is a file.
	if _, ok := r.files[p]; ok {
		return true
	}
	if _, ok := r.toWrite[p]; ok {
		return true
	}
	// Or a link, or a folder, by that very name.
	st, lerr := os.Lstat(filepath.Join(r.root, filepath.FromSlash(p)))
	return lerr == nil && (st.Mode()&os.ModeSymlink != 0 || st.IsDir())
}

// writeOut puts into the working copy what reconcile found is to be written
// and removed, and says which pages could not be. A sync with nothing to
// write, or a source that is never written to, ends here.
func (r *syncRun) writeOut() error {
	r.res.Commit = r.head()
	if (len(r.toWrite) == 0 && len(r.toRemove) == 0) || r.src.WriteMode == "none" {
		// Still said, on a sync with nothing to write: why a page has no file.
		r.sayRenamed()
		r.done = true
		return nil
	}
	r.blocked = map[string]bool{}
	for path, text := range r.toWrite {
		full := filepath.Join(r.root, filepath.FromSlash(path))
		if !staysInside(r.dir, full) {
			// Through a link: not written, not counted, and not taken as
			// synced, so the page stays as it is and the sync says why.
			r.blocked[path] = true
			delete(r.toWrite, path)
			continue
		}
		werr := os.MkdirAll(filepath.Dir(full), 0o750)
		if werr == nil {
			werr = os.WriteFile(full, []byte(text), 0o640)
		}
		if werr != nil {
			// One page that cannot be written (a folder has its file's name,
			// the disk refuses) is held back and named; the rest go on.
			r.blocked[path] = true
			delete(r.toWrite, path)
			r.s.log.Warn("repository sync: a page was not written", "source", r.src.ID, "path", path, "err", werr)
			continue
		}
	}
	for _, path := range r.toRemove {
		if full := filepath.Join(r.root, filepath.FromSlash(path)); staysInside(r.dir, full) {
			os.Remove(full)
		}
	}
	if len(r.blocked) > 0 {
		var names []string
		for path := range r.blocked {
			names = append(names, path)
		}
		sort.Strings(names)
		r.say(fmt.Sprintf("%d page(s) were not written to the repository, because a link or a file there stands in the way: %s", len(names), oneLine(strings.Join(names, ", "), 800)))
	}
	r.sayRenamed()
	return nil
}
