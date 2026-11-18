// The folder sources (markdown, obsidian): a folder of Markdown, or a zip
// of one, as a tree of pages.

package importer

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// folder reads a folder of Markdown files, or that folder as a zip (how it
// arrives through the web app), as a tree of pages. An Obsidian vault is
// such a folder; its [[links]] are followed when the plan is applied.
type folder struct{ kind string }

// Kind is "markdown" or "obsidian".
func (f folder) Kind() string { return f.kind }

// ErrUnnamed refuses a zip of a folder imported with no origin option.
var ErrUnnamed = errors.New("name this import (origin): importing again under the same name adds only what is new, and another name makes pages of its own")

// Read reads the folder, or the zip of it, at source. A file's path names
// it only within its folder, so the plan's origin names the folder: the
// origin option, the name the person gives the import and gives again to
// import the folder again; or, for a folder on this machine given none,
// its full path. A zip says nothing about where it came from, so it must
// be given a name (ErrUnnamed).
func (f folder) Read(source string, opts Options, _ *http.Client) (Plan, error) {
	dir, tmp, err := unpacked(source, f.kind, zipByName)
	if err != nil {
		return Plan{}, err
	}
	origin := strings.TrimSpace(opts["origin"])
	if origin == "" && tmp != "" {
		os.RemoveAll(tmp)
		return Plan{}, ErrUnnamed
	}
	if origin == "" {
		if origin, err = filepath.Abs(source); err != nil {
			return Plan{}, err
		}
	}
	// A zip of one folder holds that folder: read inside it.
	if entries, err := os.ReadDir(dir); tmp != "" && err == nil && len(entries) == 1 && entries[0].IsDir() {
		dir = filepath.Join(dir, entries[0].Name())
	}
	plan, err := (&tree{source: f.kind, root: dir, tmp: tmp}).read()
	plan.Origin = origin
	return plan, err
}

// zipRule says which files unpacked takes for a zip.
type zipRule int

const (
	zipByName  zipRule = iota // only a file whose name ends in .zip
	zipAnyFile                // any file, whatever its name
)

// unpacked gives the folder to read for source: source itself, or the
// temporary folder its zip was unpacked into (tmp, to remove once the plan
// is applied).
func unpacked(source, kind string, rule zipRule) (dir, tmp string, err error) {
	info, err := os.Stat(source)
	if err != nil {
		return "", "", err
	}
	if info.IsDir() || (rule == zipByName && !strings.HasSuffix(strings.ToLower(source), ".zip")) {
		return source, "", nil
	}
	tmp, err = unzipToTemp(source, kind)
	return tmp, tmp, err
}

// tree reads a folder into pages: a directory becomes a page that holds
// the files in it. The three hooks are what differs between kinds of
// folder; a plain folder of Markdown sets none.
type tree struct {
	source, root string
	tmp          string // the temporary folder root is in, if it was unpacked
	// title makes a page's title from a file or folder name (without its
	// extension).
	title func(name string) string
	// body makes a page's text from the file's.
	body func(title, text string) string
	// table reads a file that is a database, if this kind of folder has them.
	table func(path string) (cols []string, rows [][]string, ok bool)

	plan   Plan
	dirDoc map[string]bool
}

// read walks the tree into a plan of pages and databases.
func (t *tree) read() (Plan, error) {
	t.plan, t.dirDoc = Plan{Source: t.source, Tmp: t.tmp}, map[string]bool{}
	info, err := os.Stat(t.root)
	if err != nil {
		return t.plan, err
	}
	if !info.IsDir() {
		return t.plan, fmt.Errorf("%s is not a folder", t.root)
	}
	paths, err := t.files()
	if err != nil {
		return t.plan, err
	}
	for _, p := range paths {
		if err := t.file(p); err != nil {
			return t.plan, err
		}
	}
	// Parents before children, so a page's place exists when it is made.
	sort.SliceStable(t.plan.Docs, func(i, j int) bool {
		return strings.Count(t.plan.Docs[i].Ext, "/") < strings.Count(t.plan.Docs[j].Ext, "/")
	})
	return t.plan, nil
}

// files lists the files under the root in a steady order, leaving out
// hidden folders and node_modules.
func (t *tree) files() ([]string, error) {
	var paths []string
	err := filepath.WalkDir(t.root, func(p string, e os.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if e.IsDir() && p != t.root && (strings.HasPrefix(e.Name(), ".") || e.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if !e.IsDir() {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)
	return paths, err
}

// file adds what one file becomes: a page, a database, or nothing.
func (t *tree) file(p string) error {
	rel, err := filepath.Rel(t.root, p)
	if err != nil {
		return err
	}
	ext := filepath.ToSlash(strings.TrimSuffix(rel, filepath.Ext(rel)))
	switch strings.ToLower(filepath.Ext(p)) {
	case ".md", ".markdown":
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		title, text := t.name(p), string(raw)
		if t.body != nil {
			text = t.body(title, text)
		}
		t.plan.Docs = append(t.plan.Docs, Doc{Ext: ext, ParentExt: t.parent(filepath.Dir(p)), Title: title, Markdown: text, Dir: filepath.Dir(p)})
	default:
		if t.table == nil {
			return nil
		}
		if cols, rows, ok := t.table(p); ok {
			t.plan.Tables = append(t.plan.Tables, Table{Ext: ext, ParentExt: t.parent(filepath.Dir(p)), Title: t.name(p), Columns: cols, Rows: rows})
		}
	}
	return nil
}

// name is the title a file or folder gives its page.
func (t *tree) name(path string) string {
	name := filepath.Base(path)
	name = strings.TrimSuffix(name, filepath.Ext(name))
	if t.title != nil {
		name = t.title(name)
	}
	return name
}

// parent returns the page a directory stands for, making a page for each
// directory on the way unless a file of the same name is that page.
func (t *tree) parent(dir string) string {
	rel, err := filepath.Rel(t.root, dir)
	if err != nil || rel == "." {
		return "" // the root, or a folder outside it: no page
	}
	ext := filepath.ToSlash(rel)
	if !t.dirDoc[ext] {
		t.dirDoc[ext] = true
		// Notion exports "Page.md" beside a folder "Page" of its children.
		if _, err := os.Stat(dir + ".md"); err != nil {
			t.plan.Docs = append(t.plan.Docs, Doc{Ext: ext, ParentExt: t.parent(filepath.Dir(dir)), Title: t.name(dir)})
		}
	}
	return ext
}
