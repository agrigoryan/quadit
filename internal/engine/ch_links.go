// link.set and link.remove: links from a task to elsewhere, or to a page.

package engine

import (
	"cmp"
	"encoding/json"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("link.set", core.RoleMember, linkSet)
	register("link.remove", core.RoleMember, linkRemove)
}

type linkSetArgs struct {
	ID    string `json:"id"`
	Task  string `json:"task" quadit:"required,handler"`
	Kind  string `json:"kind" quadit:"required,handler"` // branch, commit, pr, issue, url, doc
	URL   string `json:"url"`
	Title string `json:"title"`
	Repo  string `json:"repo"`
	Ref   string `json:"ref"` // branch name, commit hash, pull request number, or the page's id

	State  string          `json:"state"`
	Checks string          `json:"checks"`
	Data   json.RawMessage `json:"data"`
}

// linkSet adds a link from a task to a branch, commit, pull request, URL
// or page, or updates the one already there for the same thing.
func linkSet(c *cx, a linkSetArgs) error {
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	kinds := []string{core.LinkBranch, core.LinkCommit, core.LinkPR, core.LinkIssue, core.LinkURL, core.LinkDoc}
	if !slices.Contains(kinds, a.Kind) {
		return oneOf("kind", "link kind", a.Kind, kinds)
	}
	if a.Kind == core.LinkURL && a.URL == "" {
		return invalid("url", "a url link needs a url")
	}
	if a.Kind == core.LinkDoc && a.Ref == "" {
		return invalid("ref", "a doc link needs ref: the page's id")
	}
	if a.Kind != core.LinkURL && a.Ref == "" {
		return invalid("ref", "a %s link needs ref: the branch name, commit hash or pull request number", a.Kind)
	}
	if a.Kind == core.LinkDoc {
		page, err := c.linkedPage(a.Ref)
		if err != nil {
			return err
		}
		a.Ref, a.Repo = page.ID, ""
	}
	var l core.TaskLink
	conds := []store.Cond{store.Eq("task_id", t.ID), store.Eq("kind", a.Kind), store.Live}
	if a.ID != "" {
		conds = []store.Cond{store.Eq("id", a.ID), store.Live}
	} else if a.Kind == core.LinkURL {
		conds = append(conds, store.Eq("url", a.URL))
	} else {
		conds = append(conds, store.Eq("repo", a.Repo), store.Eq("ref", a.Ref))
	}
	there, err := store.Find(c.ctx, c.tx, &l, conds...)
	if err != nil {
		return err
	}
	if !there {
		lid, err := newID("id", a.ID)
		if err != nil {
			return err
		}
		seq := c.tx.NextSeq()
		l = core.TaskLink{ID: lid, WorkspaceID: c.ws, TaskID: t.ID, Kind: a.Kind, URL: a.URL, Title: a.Title, Repo: a.Repo, Ref: a.Ref,
			State: a.State, Checks: a.Checks, Data: a.Data, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, UpdatedSeq: seq}
		if err := c.tx.Insert(c.ctx, l); err != nil {
			return err
		}
		c.ref = l.ID
		if l.Kind == core.LinkDoc {
			// The page is referenced by the task as a mention in its text
			// would make it: the page lists the task, and the task the page.
			ref := core.Ref{WorkspaceID: c.ws, FromType: "link", FromID: l.ID, FromScopeType: "task", FromScopeID: t.ID, ToType: "doc", ToID: l.Ref}
			if err := c.tx.Insert(c.ctx, ref); err != nil {
				return err
			}
		}
		if err := c.touchTask(t.ID, seq); err != nil {
			return err
		}
		return c.emit(event{seq: seq, typ: "link.created", entity: "link", entityID: l.ID, place: inTask(t), data: core.EventData{Row: l, Key: &t.Key}})
	}
	p := newPatch()
	p.put("url", l.URL, cmp.Or(a.URL, l.URL))
	p.put("title", l.Title, cmp.Or(a.Title, l.Title))
	p.put("state", l.State, cmp.Or(a.State, l.State))
	p.put("checks", l.Checks, cmp.Or(a.Checks, l.Checks))
	if len(a.Data) > 0 && string(a.Data) != string(l.Data) {
		p.set["data"] = a.Data
		p.changes["data"] = core.FieldChange{To: a.Data}
	}
	if p.empty() {
		c.ref = l.ID
		return nil
	}
	p.set["updated_at"] = c.at
	if err := c.save(p, target{table: "task_links", entity: "link", id: l.ID, place: inTask(t), extra: core.EventData{Key: &t.Key, LinkKind: l.Kind, LinkRef: &l.Ref}}); err != nil {
		return err
	}
	return c.touchTask(t.ID, c.tx.Seq())
}

func linkRemove(c *cx, a idArgs) error {
	l, err := loadLive[core.TaskLink](c, "link", "id", a.ID)
	if err != nil {
		return err
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", l.TaskID)); err != nil {
		return err
	}
	if _, err := c.tx.Delete(c.ctx, "refs", store.Eq("from_id", l.ID)); err != nil {
		return err
	}
	return c.trash(target{table: "task_links", entity: "link", id: l.ID, place: inTask(t)})
}

// linkedPage is the page a doc link names: one the actor may see, and of a
// project its access includes. A page it may not see is not there for it.
func (c *cx) linkedPage(ref string) (core.Doc, error) {
	page, err := c.loadDoc("ref", ref)
	if err != nil {
		return page, err
	}
	if page.ProjectID != "" && !c.system && len(c.scope.Projects) > 0 && !slices.Contains(c.scope.Projects, page.ProjectID) {
		e := notFound("doc", ref)
		e.Field = "ref"
		return page, e
	}
	return page, nil
}
