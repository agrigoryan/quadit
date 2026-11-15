package reposync

import (
	"fmt"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
)

// TestReconcile is the table of what a sync decides. Each row names the
// case; the rows marked with a commit are cases that were once decided
// wrong, fixed in that commit.
func TestReconcile(t *testing.T) {
	repoSays := core.DocSource{ID: "src", RootDocID: "root", Authority: core.AuthorityRepo}
	pagesSay := core.DocSource{ID: "src", RootDocID: "root", Authority: core.AuthorityPages}
	root := syncedPage{Doc: core.Doc{ID: "root", Title: "Game docs", SourceID: "src"}}
	// synced is a page as the last sync left it: its file said file, and
	// the page said markdown.
	synced := func(id, path, title, file, markdown string) syncedPage {
		return syncedPage{Doc: core.Doc{ID: id, ParentID: "root", Title: title, SourceID: "src", SourcePath: path,
			SourceHash: agreed(file, pageSide(title, file, markdown))}, Markdown: markdown}
	}
	edited := func(p syncedPage, markdown, by string, at int64) syncedPage {
		p.Markdown, p.UpdatedBy, p.UpdatedAt = markdown, by, at
		return p
	}
	trashed := func(p syncedPage) syncedPage {
		p.DeletedAt, p.Markdown = 1, ""
		return p
	}
	// madeHere is a page made in the app under parent, with no file yet.
	madeHere := func(id, parent, title, markdown string) syncedPage {
		return syncedPage{Doc: core.Doc{ID: id, ParentID: parent, Title: title, SourceID: "src", UpdatedBy: "aram", UpdatedAt: 5}, Markdown: markdown}
	}
	folderPage := func(id, path string) syncedPage {
		return syncedPage{Doc: core.Doc{ID: id, ParentID: "root", Title: path, SourceID: "src", SourcePath: path}}
	}
	underRoot := parentRef{ID: "root"}
	write := func(path, text, pageID, pageText, lastFile string) fileWrite {
		return fileWrite{Path: path, Text: text, PageID: pageID, PageHash: shortHash(pageText), LastFile: lastFile}
	}
	hashOfFile := func(p syncedPage) string {
		file, _ := splitHashes(p.SourceHash)
		return file
	}

	design := synced("d", "design.md", "Design", "# Design\n\nThree phases.\n", "Three phases.\n")
	plain := synced("p", "plain.md", "plain", "plain text\n", "plain text\n")
	// A page holds front matter as Markdown blocks, spelled its own way.
	const listed = "---\ntags:\n  - vfx\n  - boss_fight\nweight: 2\n---\n\n# Listed\n\nText.\n"
	const listedFM = "---\n\ntags:\n\n- vfx\n- boss_fight\n\nweight: 2\n\n---\n"
	fronted := synced("f", "listed.md", "Listed", listed, listedFM+"\nText.\n")
	oldStyle := syncedPage{Doc: core.Doc{ID: "o", ParentID: "root", Title: "OLD_STYLE", SourceID: "src", SourcePath: "OLD_STYLE.md",
		SourceHash: shortHash("# Old style\n\nBody.\n") + ":" + shortHash("# Old style\n\nBody.\n")}, Markdown: "# Old style\n\nBody.\n"}

	cases := []struct {
		name  string
		src   core.DocSource
		files map[string]string
		taken []string // links and folders in the repository
		pages []syncedPage
		want  plan
	}{
		{name: "a new file becomes a page called by its opening heading (e0827c3)", src: repoSays,
			files: map[string]string{"design.md": "# Design\n\nThree phases.\n"},
			pages: []syncedPage{root},
			want: plan{pages: []pageChange{
				newPage{Path: "design.md", Parent: underRoot, Title: "Design", Markdown: "Three phases.\n", File: "# Design\n\nThree phases.\n"},
			}}},
		{name: "a new file with no heading is called by its name", src: repoSays,
			files: map[string]string{"notes.md": "No heading here.\n"},
			pages: []syncedPage{root},
			want: plan{pages: []pageChange{
				newPage{Path: "notes.md", Parent: underRoot, Title: "notes", Markdown: "No heading here.\n", File: "No heading here.\n"},
			}}},
		{name: "a file with a second opening heading keeps both, and is called by its name (e0827c3)", src: repoSays,
			files: map[string]string{"two.md": "# One\n\n# Two\n"},
			pages: []syncedPage{root},
			want: plan{pages: []pageChange{
				newPage{Path: "two.md", Parent: underRoot, Title: "two", Markdown: "# One\n\n# Two\n", File: "# One\n\n# Two\n"},
			}}},
		{name: "files in folders get a page for each folder, made once, above them", src: repoSays,
			files: map[string]string{"a/b/c.md": "C.\n", "a/d.md": "D.\n"},
			pages: []syncedPage{root},
			want: plan{pages: []pageChange{
				newFolderPage{Path: "a/", Parent: underRoot, Title: "a"},
				newFolderPage{Path: "a/b/", Parent: parentRef{Folder: "a/"}, Title: "b"},
				newPage{Path: "a/b/c.md", Parent: parentRef{Folder: "a/b/"}, Title: "c", Markdown: "C.\n", File: "C.\n"},
				newPage{Path: "a/d.md", Parent: parentRef{Folder: "a/"}, Title: "d", Markdown: "D.\n", File: "D.\n"},
			}}},
		{name: "a folder whose page is live keeps it; one whose page is in the trash gets a new one", src: repoSays,
			files: map[string]string{"a/x.md": "X.\n", "b/y.md": "Y.\n"},
			pages: []syncedPage{root, folderPage("fa", "a/"), trashed(folderPage("fb", "b/"))},
			want: plan{pages: []pageChange{
				newPage{Path: "a/x.md", Parent: parentRef{ID: "fa"}, Title: "x", Markdown: "X.\n", File: "X.\n"},
				newFolderPage{Path: "b/", Parent: underRoot, Title: "b"},
				newPage{Path: "b/y.md", Parent: parentRef{Folder: "b/"}, Title: "y", Markdown: "Y.\n", File: "Y.\n"},
			}}},
		{name: "nothing changed on either side: nothing to do, and no file rewritten in the page's spelling", src: repoSays,
			files: map[string]string{"design.md": "# Design\n\nThree phases.\n", "plain.md": "plain text\n", "listed.md": listed},
			pages: []syncedPage{root, design, plain, fronted},
			want:  plan{}},
		{name: "a page synced before titles came from headings is left as it was (e0827c3)", src: repoSays,
			files: map[string]string{"OLD_STYLE.md": "# Old style\n\nBody.\n"},
			pages: []syncedPage{root, oldStyle},
			want:  plan{}},
		{name: "once its file changes, a page synced before titles came from headings takes its heading (e0827c3)", src: repoSays,
			files: map[string]string{"OLD_STYLE.md": "# Old style\n\nBody two.\n"},
			pages: []syncedPage{root, oldStyle},
			want: plan{pages: []pageChange{
				fileIntoPage{ID: "o", Retitle: true, Title: "Old style", Markdown: "Body two.\n", File: "# Old style\n\nBody two.\n"},
			}}},
		{name: "a file changed there is written into its page, its heading into the title", src: repoSays,
			files: map[string]string{"design.md": "# Boss design\n\nFive phases.\n", "plain.md": "plain, edited\n"},
			pages: []syncedPage{root, design, plain},
			want: plan{pages: []pageChange{
				fileIntoPage{ID: "d", Retitle: true, Title: "Boss design", Markdown: "Five phases.\n", File: "# Boss design\n\nFive phases.\n"},
				fileIntoPage{ID: "p", Markdown: "plain, edited\n", File: "plain, edited\n"},
			}}},
		{name: "a page changed here is written to its file with its title as the heading (e0827c3)", src: repoSays,
			files: map[string]string{"design.md": "# Design\n\nThree phases.\n"},
			pages: []syncedPage{root, edited(design, "Four phases.\n", "aram", 7)},
			want: plan{
				writes:  []fileWrite{write("design.md", "# Design\n\nFour phases.\n", "d", "# Design\n\nFour phases.\n", hashOfFile(design))},
				editors: map[string]int64{"aram": 7}}},
		{name: "a page renamed here renames the heading, not the file (e0827c3)", src: repoSays,
			files: map[string]string{"design.md": "# Design\n\nThree phases.\n"},
			pages: []syncedPage{root, func() syncedPage { p := design; p.Title = "Boss"; return p }()},
			want: plan{
				writes:  []fileWrite{write("design.md", "# Boss\n\nThree phases.\n", "d", "# Boss\n\nThree phases.\n", hashOfFile(design))},
				editors: map[string]int64{}}},
		{name: "a page's file keeps its front matter byte for byte while the page leaves it alone (ac41a0a)", src: repoSays,
			files: map[string]string{"listed.md": listed},
			pages: []syncedPage{root, edited(fronted, listedFM+"\nText two.\n", "aram", 7)},
			want: plan{
				writes: []fileWrite{write("listed.md", "---\ntags:\n  - vfx\n  - boss_fight\nweight: 2\n---\n\n# Listed\n\nText two.\n", "f",
					listedFM+"\n# Listed\n\nText two.\n", hashOfFile(fronted))},
				editors: map[string]int64{"aram": 7}}},
		{name: "both changed and the repository has the say: the file wins", src: repoSays,
			files: map[string]string{"plain.md": "file says seven\n"},
			pages: []syncedPage{root, edited(plain, "page says six\n", "aram", 7)},
			want:  plan{pages: []pageChange{fileIntoPage{ID: "p", Markdown: "file says seven\n", File: "file says seven\n"}}}},
		{name: "both changed and the pages have the say: the page wins", src: pagesSay,
			files: map[string]string{"plain.md": "file says seven\n"},
			pages: []syncedPage{root, edited(plain, "page says six\n", "aram", 7)},
			want: plan{
				writes:  []fileWrite{write("plain.md", "page says six\n", "p", "page says six\n", hashOfFile(plain))},
				editors: map[string]int64{"aram": 7}}},
		{name: "a file deleted there sends its page to the trash", src: repoSays,
			files: map[string]string{},
			pages: []syncedPage{root, plain},
			want:  plan{pages: []pageChange{trashPage{ID: "p"}}}},
		{name: "a file put back there after its page let go of it gets a page again (f4cbaea)", src: repoSays,
			files: map[string]string{"plain.md": "plain text\n"},
			pages: []syncedPage{root, func() syncedPage { p := trashed(plain); p.SourceHash = ""; return p }()},
			want: plan{pages: []pageChange{
				newPage{Path: "plain.md", Parent: underRoot, Title: "plain", Markdown: "plain text\n", File: "plain text\n"},
			}}},
		{name: "a page trashed here takes its unchanged file with it", src: repoSays,
			files: map[string]string{"plain.md": "plain text\n"},
			pages: []syncedPage{root, trashed(plain)},
			want:  plan{removals: []fileRemoval{{Path: "plain.md", PageID: "p"}}}},
		{name: "a page trashed here while its file changed there: the file is kept, and said (416e8d4)", src: repoSays,
			files: map[string]string{"plain.md": "changed there\n"},
			pages: []syncedPage{root, trashed(plain)},
			want:  plan{notes: []string{`plain.md changed in the repository after its page "plain" was deleted here; the file was kept, and restoring the page takes up its text`}}},
		{name: "a page trashed here while its file changed there, the pages having the say: the file goes", src: pagesSay,
			files: map[string]string{"plain.md": "changed there\n"},
			pages: []syncedPage{root, trashed(plain)},
			want:  plan{removals: []fileRemoval{{Path: "plain.md", PageID: "p"}}}},
		{name: "a live page holds its file's name over one in the trash", src: repoSays,
			files: map[string]string{"plain.md": "plain text\n"},
			pages: []syncedPage{root, plain, func() syncedPage { p := trashed(plain); p.ID = "p-old"; return p }()},
			want:  plan{}},
		{name: "a page made here gets a file beside its parent's", src: repoSays,
			files: map[string]string{"art/sprites.md": "Sprites.\n"},
			pages: []syncedPage{root, folderPage("fart", "art/"), synced("s", "art/sprites.md", "sprites", "Sprites.\n", "Sprites.\n"),
				madeHere("n", "fart", "Release Notes", "v0.1\n"), madeHere("u", "root", "", "Nameless.\n")},
			want: plan{
				pages: []pageChange{bindPage{ID: "n", Path: "art/release-notes.md"}, bindPage{ID: "u", Path: "untitled.md"}},
				writes: []fileWrite{write("art/release-notes.md", "v0.1\n", "n", "v0.1\n", ""),
					write("untitled.md", "Nameless.\n", "u", "Nameless.\n", "")},
				editors: map[string]int64{"aram": 5}}},
		{name: "two pages made here with one title get a file each", src: repoSays,
			files: map[string]string{},
			pages: []syncedPage{root, madeHere("a", "root", "Plan", "One.\n"), madeHere("b", "root", "Plan", "Two.\n")},
			want: plan{
				pages:   []pageChange{bindPage{ID: "a", Path: "plan.md"}, bindPage{ID: "b", Path: "plan-2.md"}},
				writes:  []fileWrite{write("plan.md", "One.\n", "a", "One.\n", ""), write("plan-2.md", "Two.\n", "b", "Two.\n", "")},
				editors: map[string]int64{"aram": 5},
				notes:   []string{`"Plan" was written as plan-2.md (plan.md is taken)`}}},
		{name: "an empty file keeps its name: a page called like it gets another one, and is told (b086155, 09a76bb)", src: repoSays,
			files: map[string]string{"empty.md": ""},
			pages: []syncedPage{root, synced("e", "empty.md", "empty", "", ""), madeHere("n", "root", "empty", "Not so empty.\n")},
			want: plan{
				pages:   []pageChange{bindPage{ID: "n", Path: "empty-2.md"}},
				writes:  []fileWrite{write("empty-2.md", "Not so empty.\n", "n", "Not so empty.\n", "")},
				editors: map[string]int64{"aram": 5},
				notes:   []string{`"empty" was written as empty-2.md (empty.md is taken)`}}},
		{name: "a link or a folder on a page's file name: the page gets another name (fc5a431, d2345ea, b3c4ee8)", src: repoSays,
			files: map[string]string{},
			taken: []string{"leak.md", "yy.md"},
			pages: []syncedPage{root, madeHere("l", "root", "leak", "Written in the app.\n"), madeHere("y", "root", "yy", "yy text\n")},
			want: plan{
				pages: []pageChange{bindPage{ID: "l", Path: "leak-2.md"}, bindPage{ID: "y", Path: "yy-2.md"}},
				writes: []fileWrite{write("leak-2.md", "Written in the app.\n", "l", "Written in the app.\n", ""),
					write("yy-2.md", "yy text\n", "y", "yy text\n", "")},
				editors: map[string]int64{"aram": 5},
				notes:   []string{`"leak" was written as leak-2.md (leak.md is taken)`, `"yy" was written as yy-2.md (yy.md is taken)`}}},
		{name: "a restored page saying what another page's file says makes no second file, and is told (09a76bb)", src: repoSays,
			files: map[string]string{"plain.md": "plain text\n"},
			pages: []syncedPage{root, plain, madeHere("r", "root", "plain", "plain text\n")},
			want: plan{
				notes:   []string{`"plain" was not written: plain.md already says the same, and has its own page; one of the two pages can go`},
				editors: map[string]int64{}}},
		{name: "a page restored after its file was deleted there is written back (b3c4ee8)", src: repoSays,
			files: map[string]string{},
			pages: []syncedPage{root, madeHere("z", "root", "za", "za v3\n")},
			want: plan{
				pages:   []pageChange{bindPage{ID: "z", Path: "za.md"}},
				writes:  []fileWrite{write("za.md", "za v3\n", "z", "za v3\n", "")},
				editors: map[string]int64{"aram": 5}}},
		{name: "a restored page that still names its file, now gone, is written again instead of trashed (b3c4ee8)", src: repoSays,
			files: map[string]string{},
			pages: []syncedPage{root, func() syncedPage { p := madeHere("z", "root", "za", "za v3\n"); p.SourcePath = "za.md"; return p }()},
			want: plan{
				pages:   []pageChange{bindPage{ID: "z", Path: "za.md"}},
				writes:  []fileWrite{write("za.md", "za v3\n", "z", "za v3\n", "")},
				editors: map[string]int64{"aram": 5}}},
		{name: "a page takes over the file of its trashed twin, which says the same: nothing goes, nothing is written (317e9cf)", src: repoSays,
			files: map[string]string{"solo.md": "solo text\n"},
			pages: []syncedPage{root, trashed(synced("t", "solo.md", "solo", "solo text\n", "solo text\n")), madeHere("s", "root", "solo", "solo text\n")},
			want: plan{
				pages:   []pageChange{unbindPage{ID: "t"}, bindPage{ID: "s", Path: "solo.md", Agreed: agreed("solo text\n", "solo text\n")}},
				editors: map[string]int64{}}},
		{name: "a page takes over the file of its trashed twin and writes what it says else (317e9cf)", src: repoSays,
			files: map[string]string{"solo.md": "solo text\n"},
			pages: []syncedPage{root, trashed(synced("t", "solo.md", "solo", "solo text\n", "solo text\n")), madeHere("s", "root", "solo", "solo, mine\n")},
			want: plan{
				pages:   []pageChange{unbindPage{ID: "t"}, bindPage{ID: "s", Path: "solo.md"}},
				writes:  []fileWrite{write("solo.md", "solo, mine\n", "s", "solo, mine\n", "")},
				editors: map[string]int64{}}},
		{name: "the commit goes to the last of the pages' editors, the others are named (1a8716a)", src: repoSays,
			files: map[string]string{"design.md": "# Design\n\nThree phases.\n", "plain.md": "plain text\n"},
			pages: []syncedPage{root, edited(design, "Four.\n", "aram", 3), edited(plain, "Five.\n", "artist", 9), madeHere("n", "root", "New", "New.\n")},
			want: plan{
				pages: []pageChange{bindPage{ID: "n", Path: "new.md"}},
				writes: []fileWrite{write("design.md", "# Design\n\nFour.\n", "d", "# Design\n\nFour.\n", hashOfFile(design)),
					write("plain.md", "Five.\n", "p", "Five.\n", hashOfFile(plain)),
					write("new.md", "New.\n", "n", "New.\n", "")},
				editors: map[string]int64{"aram": 5, "artist": 9}}},
		{name: "a page moved here under another folder's page keeps its file", src: repoSays,
			files: map[string]string{"plain.md": "plain text\n"},
			pages: []syncedPage{root, folderPage("fa", "a/"), func() syncedPage { p := plain; p.ParentID = "fa"; return p }()},
			want:  plan{}},
		{name: "the source's own page and folder pages have no file of their own to write or trash", src: repoSays,
			files: map[string]string{},
			pages: []syncedPage{root, folderPage("fa", "a/")},
			want:  plan{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := folder{files: c.files, taken: map[string]bool{}}
			for _, p := range c.taken {
				f.taken[p] = true
			}
			if got, want := describe(reconcile(c.src, f, c.pages)), describe(c.want); got != want {
				t.Errorf("reconcile decided\n%s\nwant\n%s", got, want)
			}
		})
	}
}

// describe spells a plan out, so two can be compared and a difference read.
func describe(p plan) string {
	out := ""
	for _, c := range p.pages {
		out += fmt.Sprintf("page   %#v\n", c)
	}
	for _, w := range p.writes {
		out += fmt.Sprintf("write  %#v\n", w)
	}
	for _, r := range p.removals {
		out += fmt.Sprintf("remove %#v\n", r)
	}
	if len(p.editors) > 0 {
		out += fmt.Sprintf("by     %v\n", p.editors)
	}
	for _, n := range p.notes {
		out += "says   " + n + "\n"
	}
	return out
}
