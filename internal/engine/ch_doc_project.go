package engine

import (
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
	if pid != "" && !c.system && len(c.scope.Projects) > 0 && !contains(c.scope.Projects, pid) {
		return forbidden("your access does not include this project")
	}
	u.moved, u.toProject = pid != u.d.ProjectID, pid
	u.p.put("project_id", u.d.ProjectID, pid)
	return nil
}

// sameProjectBelow returns the pages under a page that are in its project,
// down to the first that is not. A page under it that was tied to another
// project, or to none, was put there on purpose: it and what is under it
// are left out. Pages in the trash count, so one restored later comes back
// where its parent is.
func (c *cx) sameProjectBelow(root core.Doc) ([]core.Doc, error) {
	var out []core.Doc
	for at := []core.Doc{root}; len(at) > 0 && len(out) < 20_000; at = at[1:] {
		var kids []core.Doc
		if err := c.tx.List(c.ctx, &kids, store.Q{Where: []store.Cond{store.Eq("parent_id", at[0].ID)}, Order: "rank"}); err != nil {
			return nil, err
		}
		for _, k := range kids {
			if k.ProjectID == root.ProjectID {
				out = append(out, k)
				at = append(at, k)
			}
		}
	}
	return out, nil
}

// moveSubPages takes the pages under a page along when its project
// changes: a sub-page is in the project because its parent is, as it was
// when it was made. Each says so in the feed, and search keeps each to
// those who may see the project it is in now.
func (c *cx) moveSubPages(root core.Doc, toProject string) error {
	below, err := c.sameProjectBelow(root)
	if err != nil {
		return err
	}
	change := map[string]core.FieldChange{"project_id": {From: zeroNil(root.ProjectID), To: zeroNil(toProject)}}
	for _, d := range below {
		seq := c.tx.NextSeq()
		if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"project_id": toProject, "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
			return err
		}
		if err := c.emitTo(docAudience(d), seq, "doc.updated", "doc", d.ID, "doc", d.ID, d.ProjectID, map[string]any{"id": d.ID, "changes": change}); err != nil {
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
	return c.emitTo(docAudience(now), c.tx.NextSeq(), "doc.updated", "doc", now.ID, "doc", now.ID, now.ProjectID, map[string]any{"row": now})
}
