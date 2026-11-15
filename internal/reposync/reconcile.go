package reposync

// What a sync decides: from what the source's folder holds and what its
// pages say, which page each file makes, changes or trashes, and which file
// each page writes, takes over or removes. Nothing here reads or writes
// anything; Sync carries the decisions out.

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"path"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// syncedPage is one of the source's pages, those in the trash too.
type syncedPage struct {
	core.Doc
	// Markdown is the page's text. It is read only for a live page that
	// stands for a file: not the source's own page, not a folder's.
	Markdown string
}

// folder is what the working copy holds in the source's folder.
type folder struct {
	files map[string]string // each Markdown file: path under the folder -> text
	// taken are other paths under the folder that no page's file may be
	// given: a link, a folder or a file too large to be a page stands there.
	taken   map[string]bool
	missing bool // the repository has no such folder (yet)
}

// plan is what reconcile decided.
type plan struct {
	// pages are the changes to pages, in order: a folder's page is made
	// before the pages it holds.
	pages    []pageChange
	writes   []fileWrite
	removals []fileRemoval
	editors  map[string]int64 // user id -> when they last changed a page being written
	notes    []string         // what the sync says about single pages and files
}

// pageChange is one of the types below.
type pageChange any

// parentRef is where a new page goes: under an existing page, or under the
// page this plan makes for a folder.
type parentRef struct {
	ID     string
	Folder string // the folder's path, with its trailing slash
}

// newFolderPage makes the page for a folder of the repository.
type newFolderPage struct {
	Path   string // with a trailing slash
	Parent parentRef
	Title  string
}

// newPage makes the page of a file that has none.
type newPage struct {
	Path            string
	Parent          parentRef
	Title, Markdown string
	File            string // the file's text, for what both sides agree on
}

// fileIntoPage writes a file's text into its page, and its heading into
// the page's title when Retitle is set.
type fileIntoPage struct {
	ID              string
	Retitle         bool
	Title, Markdown string
	File            string
}

// trashPage sends a page to the trash because its file is gone from the
// repository. The page lets go of the file's name: should the file come
// back there (a reverted commit), it is a file like any new one and gets
// its page, instead of being deleted again on this page's behalf.
type trashPage struct{ ID string }

// bindPage gives a page a file. Agreed, when set, is what both sides
// already agree on, so nothing has to be written.
type bindPage struct{ ID, Path, Agreed string }

// unbindPage takes its file from a page.
type unbindPage struct{ ID string }

// fileWrite is a page's text to be written to its file.
type fileWrite struct {
	Path, Text string
	PageID     string
	PageHash   string // the page's text as written, for the next sync to compare
	// LastFile is the file's hash at the last sync: while a proposal waits
	// to be merged, the branch still has that file.
	LastFile string
}

// fileRemoval is a file to be removed, and the page that had it.
type fileRemoval struct{ Path, PageID string }

// reconcile settles every file against its page, then every page that has
// no file. Where both changed since the last sync, src.Authority says which
// wins.
func reconcile(src core.DocSource, f folder, pages []syncedPage) plan {
	p := plan{editors: map[string]int64{}}
	byID, byPath := map[string]syncedPage{}, map[string]syncedPage{}
	for _, page := range pages {
		byID[page.ID] = page
		// A live page holds its path over one in the trash.
		if page.SourcePath != "" && (page.DeletedAt == 0 || byPath[page.SourcePath].ID == "") {
			byPath[page.SourcePath] = page
		}
	}
	writing := map[string]bool{}
	write := func(filePath string, page syncedPage, text string) {
		lastFile, _ := splitHashes(page.SourceHash)
		// The file keeps its own front matter while the page says the same.
		p.writes = append(p.writes, fileWrite{Path: filePath, Text: keepFrontMatter(f.files[filePath], text), PageID: page.ID,
			PageHash: shortHash(text), LastFile: lastFile})
		writing[filePath] = true
	}
	// A path cannot be given to a page's file when a file is there (by
	// being there, not by having text: an empty file is a file), when
	// another page is written there, or when something that is no page
	// stands on it (folder.taken).
	taken := func(filePath string) bool {
		_, isFile := f.files[filePath]
		return isFile || writing[filePath] || f.taken[filePath]
	}
	editedBy := func(page syncedPage) {
		if page.UpdatedBy != "" && page.UpdatedAt >= p.editors[page.UpdatedBy] {
			p.editors[page.UpdatedBy] = page.UpdatedAt
		}
	}
	// The page for a folder, made with the pages of the folders above it
	// when it has none yet.
	made := map[string]bool{}
	var folderPage func(dir string) parentRef
	folderPage = func(dir string) parentRef {
		if dir == "." || dir == "" {
			return parentRef{ID: src.RootDocID}
		}
		key := dir + "/"
		if made[key] {
			return parentRef{Folder: key}
		}
		if page, ok := byPath[key]; ok && page.DeletedAt == 0 {
			return parentRef{ID: page.ID}
		}
		parent := folderPage(path.Dir(dir))
		p.pages = append(p.pages, newFolderPage{Path: key, Parent: parent, Title: path.Base(dir)})
		made[key] = true
		return parentRef{Folder: key}
	}

	for _, filePath := range slices.Sorted(maps.Keys(f.files)) {
		text := f.files[filePath]
		page, known := byPath[filePath]
		switch {
		case !known || page.DeletedAt != 0 && page.SourceHash == "":
			// A new file, or one whose page let go of it: it gets a page,
			// called by its opening heading, or else by its name.
			title, markdown := strings.TrimSuffix(path.Base(filePath), path.Ext(filePath)), text
			if heading, rest, ok := titleOfFile(text); ok {
				title, markdown = heading, rest
			}
			p.pages = append(p.pages, newPage{Path: filePath, Parent: folderPage(path.Dir(filePath)), Title: title, Markdown: markdown, File: text})

		case page.DeletedAt != 0:
			// The page went to the trash here: the file goes too, unless
			// the file changed since and the repository has the say.
			lastFile, _ := splitHashes(page.SourceHash)
			if shortHash(text) == lastFile || src.Authority == core.AuthorityPages {
				p.removals = append(p.removals, fileRemoval{Path: filePath, PageID: page.ID})
				continue
			}
			p.notes = append(p.notes, fmt.Sprintf("%s changed in the repository after its page %q was deleted here; the file was kept, and restoring the page takes up its text",
				filePath, cmp.Or(page.Title, "untitled")))

		default:
			// The page is as it was if its text, with or without its title
			// as the heading, is what was synced last: the file's heading
			// may have come or gone since.
			lastFile, lastPage := splitHashes(page.SourceHash)
			pageChanged := shortHash(page.Markdown) != lastPage && shortHash(withHeading(page.Title, page.Markdown)) != lastPage
			fileChanged := shortHash(text) != lastFile
			switch {
			case fileChanged && (!pageChanged || src.Authority == core.AuthorityRepo):
				// A file that opens with a heading gives the page its
				// title, and the rest its text.
				change := fileIntoPage{ID: page.ID, Markdown: text, File: text}
				if heading, rest, ok := titleOfFile(text); ok {
					change.Retitle, change.Title, change.Markdown = heading != page.Title, heading, rest
				}
				p.pages = append(p.pages, change)
			case pageChanged:
				write(filePath, page, pageSide(page.Title, text, page.Markdown))
				editedBy(page)
			}
		}
	}

	// Pages with no file: made here, or their file was deleted there.
	for _, page := range pages {
		if page.DeletedAt != 0 || page.ID == src.RootDocID || strings.HasSuffix(page.SourcePath, "/") {
			continue
		}
		if _, has := f.files[page.SourcePath]; has && page.SourcePath != "" {
			continue
		}
		if page.SourcePath != "" && page.SourceHash != "" {
			p.pages = append(p.pages, trashPage{ID: page.ID})
			continue
		}

		// A page made in the app: its file goes beside its parent's.
		dirOf := ""
		if parent, ok := byID[page.ParentID]; ok && strings.HasSuffix(parent.SourcePath, "/") {
			dirOf = parent.SourcePath
		}
		filePath := dirOf + fileSlug(page.Title) + ".md"

		// The file by its name is about to be removed, because the page
		// that had it went to the trash: this page takes the file over
		// instead, so the repository never sees it go and come back. It is
		// written only if the page says something else than it does.
		if at := slices.IndexFunc(p.removals, func(r fileRemoval) bool { return r.Path == filePath }); at >= 0 {
			p.removals = slices.Delete(p.removals, at, at+1)
			if owner, ok := byPath[filePath]; ok && owner.ID != page.ID {
				p.pages = append(p.pages, unbindPage{ID: owner.ID})
			}
			file := f.files[filePath]
			side := pageSide(page.Title, file, page.Markdown)
			if strings.TrimSpace(file) == strings.TrimSpace(side) {
				p.pages = append(p.pages, bindPage{ID: page.ID, Path: filePath, Agreed: agreed(file, side)})
				continue
			}
			write(filePath, page, side)
			p.pages = append(p.pages, bindPage{ID: page.ID, Path: filePath})
			continue
		}

		// A name nothing in the repository has yet: a link is not a page,
		// and is not written through.
		natural := filePath
		for n := 2; taken(filePath); n++ {
			filePath = fmt.Sprintf("%s%s-%d.md", dirOf, fileSlug(page.Title), n)
		}
		if filePath != natural {
			// Said in the answer: someone who made or restored a page
			// should learn that the name was taken, and when the two say
			// the same thing, that one of them is one too many.
			title := cmp.Or(page.Title, "untitled")
			if text, ok := f.files[natural]; ok && strings.TrimSpace(text) == strings.TrimSpace(page.Markdown) {
				// A second page saying exactly what that file says (a page
				// brought back from the trash after its file returned): no
				// second file is made of it while it says nothing new.
				p.notes = append(p.notes, fmt.Sprintf("%q was not written: %s already says the same, and has its own page; one of the two pages can go", title, natural))
				continue
			}
			p.notes = append(p.notes, fmt.Sprintf("%q was written as %s (%s is taken)", title, filePath, natural))
		}
		p.pages = append(p.pages, bindPage{ID: page.ID, Path: filePath})
		write(filePath, page, page.Markdown)
		editedBy(page)
	}
	return p
}

// counts says how many pages the plan makes, updates and trashes.
func (p plan) counts() (created, updated, trashed int) {
	for _, change := range p.pages {
		switch change.(type) {
		case newPage:
			created++
		case fileIntoPage:
			updated++
		case trashPage:
			trashed++
		}
	}
	return created, updated, trashed
}

// What both sides agreed on at the last sync is stored with the page as
// "file:page", a short hash of each. The file's text and the page's
// Markdown differ in spelling (spacing, list markers), so each is compared
// with its own hash.

func shortHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

func splitHashes(h string) (file, page string) {
	file, page, _ = strings.Cut(h, ":")
	return file, page
}

// agreed is what is stored when a file and a page's side of it (see
// pageSide) say the same.
func agreed(file, pageSide string) string {
	return shortHash(file) + ":" + shortHash(pageSide)
}

// fileSlug is the name of a page's file, without ".md": its title in
// lower-case Latin letters and digits, or "untitled" when that leaves none.
func fileSlug(title string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(title)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = strings.Trim(out[:40], "-")
	}
	return cmp.Or(out, "untitled")
}
