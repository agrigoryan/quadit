// source.*: the repositories pages are mirrored from.

package engine

import (
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers source.*.
func init() {
	register("source.create", core.RoleAdmin, sourceCreate)
	register("source.update", core.RoleAdmin, sourceUpdate)
	register("source.delete", core.RoleAdmin, sourceDelete)
}

type sourceArgs struct {
	ID string `json:"id"`
	// Root is the page the repository's files appear under. Leave it out on
	// create to have one made, named by Title.
	Root   string      `json:"root"`
	Title  string      `json:"title"`
	Repo   Opt[string] `json:"repo"` // a path on the server, or a URL git can clone
	Branch Opt[string] `json:"branch"`
	Subdir Opt[string] `json:"subdir"`
	// Authority says who wins when a file and its page both changed since
	// the last sync: repo (default) or pages.
	Authority Opt[string] `json:"authority"`
	// WriteMode says what happens to page edits: commit (default) pushes
	// them to the branch, propose pushes them to a side branch for review,
	// none leaves the repository alone (pages are read-only).
	WriteMode Opt[string] `json:"write_mode"`
}

var (
	authorities = []string{"repo", "pages"}
	writeModes  = []string{"commit", "propose", "none"}
)

// sourceCreate adds a repository whose files are mirrored as pages.
func sourceCreate(c *cx, a sourceArgs) error {
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Repo.V) == "" {
		return invalid("repo", "give the repository: a path on the server, or a URL git can clone")
	}
	if err := checkSubdir(a.Subdir.V); err != nil {
		return err
	}
	src := core.DocSource{ID: sid, WorkspaceID: c.ws, Repo: strings.TrimSpace(a.Repo.V), Branch: a.Branch.V, Subdir: strings.Trim(a.Subdir.V, "/"),
		Authority: firstNonEmpty(a.Authority.V, "repo"), WriteMode: firstNonEmpty(a.WriteMode.V, "commit"), CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if !slices.Contains(authorities, src.Authority) {
		return oneOf("authority", "authority", src.Authority, authorities)
	}
	if !slices.Contains(writeModes, src.WriteMode) {
		return oneOf("write_mode", "write mode", src.WriteMode, writeModes)
	}
	if a.Root != "" {
		root, err := c.loadDoc("root", a.Root)
		if err != nil {
			return err
		}
		src.RootDocID = root.ID
	} else {
		title := a.Title
		if title == "" {
			title = strings.TrimSuffix(src.Repo[strings.LastIndexAny(src.Repo, "/:")+1:], ".git")
		}
		if err := c.applyNested("doc.create", docCreateArgs{Title: title, Icon: "git"}); err != nil {
			return err
		}
		src.RootDocID = c.subRef
	}
	seq := c.tx.NextSeq()
	src.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, src); err != nil {
		return alreadyInUse(err, "id", sid)
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"source_id": src.ID}, store.Eq("id", src.RootDocID)); err != nil {
		return err
	}
	return c.created(seq, "source", src.ID, place{scopeType: "doc", scopeID: src.RootDocID}, src)
}

// sourceUpdate changes a mirrored repository.
func sourceUpdate(c *cx, a sourceArgs) error {
	src, err := loadLive[core.DocSource](c, "source", "id", a.ID)
	if err != nil {
		return err
	}
	if a.Title != "" || a.Root != "" {
		return invalid("title", "a source keeps the page it was made under; to rename that page use doc.update {\"id\": %q, \"title\": …}", src.RootDocID)
	}
	p := newPatch()
	if err := p.name("repo", a.Repo, &src.Repo); err != nil {
		return err
	}
	p.setText("branch", a.Branch, &src.Branch)
	if a.Subdir.Set {
		if err := checkSubdir(a.Subdir.V); err != nil {
			return err
		}
		a.Subdir.V = strings.Trim(a.Subdir.V, "/")
	}
	p.setText("subdir", a.Subdir, &src.Subdir)
	if a.Authority.Set {
		if !slices.Contains(authorities, a.Authority.V) {
			return oneOf("authority", "authority", a.Authority.V, authorities)
		}
		p.setText("authority", a.Authority, &src.Authority)
	}
	if a.WriteMode.Set {
		if !slices.Contains(writeModes, a.WriteMode.V) {
			return oneOf("write_mode", "write mode", a.WriteMode.V, writeModes)
		}
		p.setText("write_mode", a.WriteMode, &src.WriteMode)
	}
	return c.save(p, target{table: "doc_sources", entity: "source", id: src.ID, place: place{scopeType: "doc", scopeID: src.RootDocID}})
}

// sourceDelete stops mirroring a repository. The pages stay as ordinary pages.
func sourceDelete(c *cx, a idArgs) error {
	src, err := loadLive[core.DocSource](c, "source", "id", a.ID)
	if err != nil {
		return err
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"source_id": "", "source_path": "", "source_hash": ""}, store.Eq("source_id", src.ID)); err != nil {
		return err
	}
	return c.trash(target{table: "doc_sources", entity: "source", id: src.ID, place: place{scopeType: "doc", scopeID: src.RootDocID}})
}

// checkSubdir keeps a source's folder inside its repository: no way up and
// out of it, and nothing of git's own.
func checkSubdir(dir string) error {
	for _, part := range strings.FieldsFunc(dir, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." || part == ".git" {
			return invalid("subdir", "the folder is a path inside the repository, such as docs or docs/handbook; %q leads out of it", dir)
		}
	}
	return nil
}
