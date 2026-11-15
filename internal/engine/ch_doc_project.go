// Moving a page, and the pages under it, to another project.

package engine

import (
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// project ties the page to a project, or to none. The project decides who
// may see the page, so nobody moves one into a project they cannot see.
func (u *pageEdit) project() error {
	c, a := u.c, u.a
	if !a.Project.Set {
		return nil
	}
	pid := ""
	if !a.Project.Null && a.Project.V != "" {
		pr, err := c.project(a.Project.V)
		if err != nil {
			return err
		}
		pid = pr.ID
	}
	if pid != "" && !c.system && len(c.scope.Projects) > 0 && !slices.Contains(c.scope.Projects, pid) {
		return forbidden("your access does not include this project")
	}
	u.moved, u.toProject = pid != u.d.ProjectID, pid
	u.p.put("project_id", u.d.ProjectID, pid)
	return nil
}

// moveSubPages takes the pages under a page along when its project
// changes: a sub-page is in the project because its parent is, as it was
// when it was made. A page under it that was tied to another project, or
// to none, was put there on purpose: it and what is under it are left out.
// Each says so in the feed, and search keeps each to those who may see the
// project it is in now.
func (c *cx) moveSubPages(root core.Doc, toProject string) error {
	below, err := c.below(root, func(k core.Doc) bool { return k.ProjectID == root.ProjectID })
	if err != nil {
		return err
	}
	change := map[string]core.FieldChange{"project_id": {From: nullIfEmpty(root.ProjectID), To: nullIfEmpty(toProject)}}
	for _, d := range below {
		seq := c.tx.NextSeq()
		if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"project_id": toProject, "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
			return err
		}
		if err := c.emit(event{seq: seq, typ: "doc.updated", entity: "doc", entityID: d.ID, place: inDoc(d), audience: docAudience(d), data: core.EventData{ID: d.ID, Changes: change}}); err != nil {
			return err
		}
		if err := c.tellNewProject(d); err != nil {
			return err
		}
		if d.DeletedAt != 0 {
			continue // not in search while it is in the trash
		}
		d.ProjectID = toProject
		if err := c.reindexDoc(d); err != nil {
			return err
		}
	}
	return nil
}

// tellNewProject says a page has come into a project to those who see that
// project and not the one it left. The change itself is told to those who
// see the old project; these hear nothing addressed to it and may be seeing
// the page for the first time, so they get all of it. Nobody is missed when
// the page had no project: it was everyone's already.
func (c *cx) tellNewProject(was core.Doc) error {
	if was.ProjectID == "" {
		return nil
	}
	var now core.Doc
	if err := c.tx.Get(c.ctx, &now, store.Eq("id", was.ID)); err != nil {
		return err
	}
	return c.emit(event{seq: c.tx.NextSeq(), typ: "doc.updated", entity: "doc", entityID: now.ID, place: inDoc(now), audience: docAudience(now), data: core.EventData{Row: now}})
}
