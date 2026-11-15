package engine

import (
	"encoding/json"
	"errors"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("link.set", core.RoleMember, linkSet)
	register("link.remove", core.RoleMember, linkRemove)
}

type linkSetArgs struct {
	ID     string          `json:"id"`
	Task   string          `json:"task"`
	Kind   string          `json:"kind"` // branch, commit, pr, url
	URL    string          `json:"url"`
	Title  string          `json:"title"`
	Repo   string          `json:"repo"`
	Ref    string          `json:"ref"` // branch name, commit hash or pull request number
	State  string          `json:"state"`
	Checks string          `json:"checks"`
	Data   json.RawMessage `json:"data"`
}

// linkSet adds a link from a task to a branch, commit, pull request or URL,
// or updates the one already there for the same thing.
func linkSet(c *cx, a linkSetArgs) error {
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	kinds := []string{"branch", "commit", "pr", "issue", "url"}
	if !contains(kinds, a.Kind) {
		return oneOf("kind", "link kind", a.Kind, kinds)
	}
	if a.Kind == "url" && a.URL == "" {
		return invalid("url", "a url link needs a url")
	}
	if a.Kind != "url" && a.Ref == "" {
		return invalid("ref", "a %s link needs ref: the branch name, commit hash or pull request number", a.Kind)
	}
	var l core.TaskLink
	conds := []store.Cond{store.Eq("task_id", t.ID), store.Eq("kind", a.Kind), store.Live}
	if a.ID != "" {
		conds = []store.Cond{store.Eq("id", a.ID), store.Live}
	} else if a.Kind == "url" {
		conds = append(conds, store.Eq("url", a.URL))
	} else {
		conds = append(conds, store.Eq("repo", a.Repo), store.Eq("ref", a.Ref))
	}
	err = c.tx.Get(c.ctx, &l, conds...)
	if errors.Is(err, store.ErrNotFound) {
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
		if err := c.touchTask(t.ID, seq); err != nil {
			return err
		}
		return c.emit(seq, "link.created", "link", l.ID, "task", t.ID, t.ProjectID, map[string]any{"row": l, "key": t.Key})
	}
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("url", l.URL, firstNonEmpty(a.URL, l.URL))
	p.put("title", l.Title, firstNonEmpty(a.Title, l.Title))
	p.put("state", l.State, firstNonEmpty(a.State, l.State))
	p.put("checks", l.Checks, firstNonEmpty(a.Checks, l.Checks))
	if len(a.Data) > 0 && string(a.Data) != string(l.Data) {
		p.set["data"] = a.Data
		p.changes["data"] = core.FieldChange{To: a.Data}
	}
	if p.empty() {
		c.ref = l.ID
		return nil
	}
	p.set["updated_at"] = c.at
	if err := c.save(p, "task_links", "link", l.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key, "kind": l.Kind, "ref": l.Ref}); err != nil {
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
	return c.trash("task_links", "link", l.ID, "task", t.ID, t.ProjectID, nil)
}
