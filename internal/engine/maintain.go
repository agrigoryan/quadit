package engine

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

// Reindex rebuilds a workspace's full-text index from its rows. It is run
// after a restore, since the index itself is not part of a backup.
func (e *Engine) Reindex(ctx context.Context, workspaceID string) error {
	db := e.st.In(workspaceID)
	tasks, err := db.Tasks(ctx, store.TaskFilter{Archived: true, Limit: 5000})
	for more := tasks; err == nil && len(more) == 5000; {
		more, err = db.Tasks(ctx, store.TaskFilter{Archived: true, Limit: 5000, Offset: len(tasks)})
		tasks = append(tasks, more...)
	}
	if err != nil {
		return err
	}
	byID := map[string]core.Task{}
	for _, t := range tasks {
		byID[t.ID] = t
		if err := db.Index(ctx, store.SearchDoc{Kind: "task", EntityID: t.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID,
			Title: t.Key + " " + t.Title, Body: t.Description}); err != nil {
			return err
		}
	}
	var docs []core.Doc
	if err := db.List(ctx, &docs, store.Where(store.Live)); err != nil {
		return err
	}
	docByID := map[string]core.Doc{}
	for _, d := range docs {
		docByID[d.ID] = d
		var blocks []core.Block
		if err := db.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID), store.Live}, Order: "rank"}); err != nil {
			return err
		}
		var b strings.Builder
		var walk func([]md.Block)
		walk = func(list []md.Block) {
			for _, bl := range list {
				b.WriteString(md.Plain(bl) + "\n")
				walk(bl.Children)
			}
		}
		walk(BlockTree(blocks))
		if err := db.Index(ctx, store.SearchDoc{Kind: "doc", EntityID: d.ID, ScopeType: "doc", ScopeID: d.ID, ProjectID: d.ProjectID,
			AudienceID: d.OwnerID, Title: d.Title, Body: b.String()}); err != nil {
			return err
		}
	}
	var comments []core.Comment
	if err := db.List(ctx, &comments, store.Where(store.Live)); err != nil {
		return err
	}
	for _, cm := range comments {
		sd := store.SearchDoc{Kind: "comment", EntityID: cm.ID, Body: cm.Body}
		if t, ok := byID[cm.TaskID]; ok {
			sd.ScopeType, sd.ScopeID, sd.ProjectID, sd.Title = "task", t.ID, t.ProjectID, t.Key+" "+t.Title
		} else if d, ok := docByID[cm.DocID]; ok {
			sd.ScopeType, sd.ScopeID, sd.ProjectID, sd.Title, sd.AudienceID = "doc", d.ID, d.ProjectID, d.Title, d.OwnerID
		} else {
			continue
		}
		if err := db.Index(ctx, sd); err != nil {
			return err
		}
	}
	var decisions []core.Decision
	if err := db.List(ctx, &decisions, store.Where(store.Live)); err != nil {
		return err
	}
	for _, d := range decisions {
		t, ok := byID[d.TaskID]
		if !ok {
			continue
		}
		var opts []core.Option
		if err := db.List(ctx, &opts, store.Where(store.Eq("decision_id", d.ID), store.Live)); err != nil {
			return err
		}
		body := d.Details
		for _, o := range opts {
			body += "\n" + o.Label + " " + o.Description
		}
		if err := db.Index(ctx, store.SearchDoc{Kind: "decision", EntityID: d.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: d.Question, Body: body}); err != nil {
			return err
		}
	}
	var epics []core.Epic
	if err := db.List(ctx, &epics, store.Where(store.Live)); err != nil {
		return err
	}
	for _, ep := range epics {
		if err := db.Index(ctx, store.SearchDoc{Kind: "epic", EntityID: ep.ID, ScopeType: "epic", ScopeID: ep.ID, ProjectID: ep.ProjectID, Title: ep.Name, Body: ep.Description}); err != nil {
			return err
		}
	}
	return nil
}

// PurgeTrash removes for good what has been in the trash longer than keep.
// It returns the storage keys of the files it removed, for the caller to
// delete from file storage.
func (e *Engine) PurgeTrash(ctx context.Context, keep time.Duration) (purged int, blobKeys []string, err error) {
	cutoff := e.now().Add(-keep).UnixMilli()
	var wss []core.Workspace
	if err := e.st.List(ctx, &wss, store.Where(store.Live)); err != nil {
		return 0, nil, err
	}
	for _, ws := range wss {
		var owner core.Member
		if err := e.st.In(ws.ID).Get(ctx, &owner, store.Eq("role", string(core.RoleOwner))); err != nil {
			continue
		}
		err := e.System(ctx, ws.ID, owner.UserID, func(s *Sys) error {
			tx, c := s.c.tx, s.c
			del := func(table string, conds ...store.Cond) error {
				_, err := tx.Delete(ctx, table, conds...)
				return err
			}
			tasks, err := tx.Tasks(ctx, store.TaskFilter{InTrash: true, Limit: 5000})
			if err != nil {
				return err
			}
			for _, t := range tasks {
				if t.DeletedAt > cutoff {
					continue
				}
				var ds []core.Decision
				if err := tx.List(ctx, &ds, store.Where(store.Eq("task_id", t.ID))); err != nil {
					return err
				}
				for _, d := range ds {
					if err := del("decision_options", store.Eq("decision_id", d.ID)); err != nil {
						return err
					}
				}
				if _, err := tx.Update(ctx, "tasks", map[string]any{"parent_id": ""}, store.Eq("parent_id", t.ID)); err != nil {
					return err
				}
				for _, step := range []struct {
					table string
					cond  store.Cond
				}{{"decisions", store.Eq("task_id", t.ID)}, {"comments", store.Eq("task_id", t.ID)}, {"attachments", store.Eq("task_id", t.ID)},
					{"task_labels", store.Eq("task_id", t.ID)}, {"task_relations", store.Eq("task_id", t.ID)}, {"task_relations", store.Eq("related_task_id", t.ID)},
					{"task_links", store.Eq("task_id", t.ID)}, {"watchers", store.Eq("subject_id", t.ID)}, {"notifications", store.Eq("task_id", t.ID)},
					{"refs", store.Eq("from_scope_id", t.ID)}, {"refs", store.Eq("to_id", t.ID)}, {"tasks", store.Eq("id", t.ID)}} {
					if err := del(step.table, step.cond); err != nil {
						return err
					}
				}
				if err := c.gone("task", t.ID, "task", t.ID, t.ProjectID); err != nil {
					return err
				}
				purged++
			}
			var docs []core.Doc
			if err := tx.List(ctx, &docs, store.Where(store.NotNull("deleted_at"), store.Lte("deleted_at", cutoff))); err != nil {
				return err
			}
			for _, d := range docs {
				if _, err := tx.Update(ctx, "docs", map[string]any{"parent_id": ""}, store.Eq("parent_id", d.ID)); err != nil {
					return err
				}
				for _, step := range []struct {
					table string
					cond  store.Cond
				}{{"doc_blocks", store.Eq("doc_id", d.ID)}, {"doc_versions", store.Eq("doc_id", d.ID)}, {"comments", store.Eq("doc_id", d.ID)},
					{"db_properties", store.Eq("database_id", d.ID)}, {"db_views", store.Eq("database_id", d.ID)}, {"attachments", store.Eq("subject_id", d.ID)},
					{"watchers", store.Eq("subject_id", d.ID)}, {"refs", store.Eq("from_scope_id", d.ID)}, {"refs", store.Eq("to_id", d.ID)}, {"docs", store.Eq("id", d.ID)}} {
					if err := del(step.table, step.cond); err != nil {
						return err
					}
				}
				if err := c.emitTo(d.OwnerID, tx.NextSeq(), "doc.deleted", "doc", d.ID, "doc", d.ID, d.ProjectID, map[string]any{"id": d.ID, "gone": true}); err != nil {
					return err
				}
				purged++
			}
			// Files nothing shows any more.
			var files []core.File
			if err := tx.List(ctx, &files, store.Where(store.NotNull("deleted_at"), store.Lte("deleted_at", cutoff))); err != nil {
				return err
			}
			for _, f := range files {
				if n, err := tx.Count(ctx, "attachments", store.Eq("file_id", f.ID), store.Live); err != nil || n > 0 {
					continue
				}
				if err := del("attachments", store.Eq("file_id", f.ID)); err != nil {
					return err
				}
				if err := del("files", store.Eq("id", f.ID)); err != nil {
					return err
				}
				blobKeys = append(blobKeys, f.StorageKey)
				if f.PreviewKey != "" {
					blobKeys = append(blobKeys, f.PreviewKey)
				}
				purged++
			}
			return nil
		})
		if err != nil {
			return purged, blobKeys, err
		}
	}
	return purged, blobKeys, nil
}

// PurgeWorkspaces removes for good the workspaces deleted more than keep
// ago: every row that belongs to them, and returns the prefixes under which
// their files are stored.
func (e *Engine) PurgeWorkspaces(ctx context.Context, keep time.Duration) (prefixes []string, err error) {
	cutoff := e.now().Add(-keep).UnixMilli()
	var wss []core.Workspace
	if err := e.st.List(ctx, &wss, store.Where(store.NotNull("deleted_at"), store.Lt("deleted_at", cutoff))); err != nil {
		return nil, err
	}
	tables := store.Tables()
	for _, ws := range wss {
		err := e.st.Atomic(ctx, func(db store.DB) error {
			// Children before parents: the reverse of the order a restore loads in.
			for i := len(tables) - 1; i >= 0; i-- {
				t := tables[i]
				if t.Global || t.Name == "workspaces" {
					continue
				}
				if _, err := db.Delete(ctx, t.Name, store.Eq("workspace_id", ws.ID)); err != nil {
					return fmt.Errorf("%s: %w", t.Name, err)
				}
			}
			// Its agents are accounts of this workspace only.
			if _, err := db.Delete(ctx, "users", store.Eq("workspace_id", ws.ID), store.Eq("kind", core.KindAgent)); err != nil {
				return err
			}
			_, err := db.Delete(ctx, "workspaces", store.Eq("id", ws.ID))
			return err
		})
		if err != nil {
			return prefixes, fmt.Errorf("purging workspace %s: %w", ws.Slug, err)
		}
		prefixes = append(prefixes, ws.ID+"/")
	}
	return prefixes, nil
}
