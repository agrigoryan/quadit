// Background upkeep: reindexing, purging the trash, announcing restores.

package engine

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

// Reindex rebuilds a workspace's full-text index from its rows. It is run
// after a restore, since the index itself is not part of a backup.
func (e *Engine) Reindex(ctx context.Context, workspaceID string) error {
	r := &reindex{ctx: ctx, db: e.st.In(workspaceID), tasks: map[string]core.Task{}, docs: map[string]core.Doc{}}
	for _, step := range []func() error{r.indexTasks, r.indexDocs, r.indexComments, r.indexDecisions, r.indexEpics} {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// reindex is one run of Reindex: the tasks and pages it has indexed, kept by
// id for the comments and decisions on them.
type reindex struct {
	ctx   context.Context
	db    store.DB
	tasks map[string]core.Task
	docs  map[string]core.Doc
}

// reindexPage is how many tasks are read at a time.
const reindexPage = 5000

// indexTasks indexes every task, the archived ones too.
func (r *reindex) indexTasks() error {
	tasks, err := r.db.Tasks(r.ctx, store.TaskFilter{Archived: true, Limit: reindexPage})
	for more := tasks; err == nil && len(more) == reindexPage; {
		more, err = r.db.Tasks(r.ctx, store.TaskFilter{Archived: true, Limit: reindexPage, Offset: len(tasks)})
		tasks = append(tasks, more...)
	}
	if err != nil {
		return err
	}
	for _, t := range tasks {
		r.tasks[t.ID] = t
		if err := r.db.Index(r.ctx, store.SearchDoc{Kind: "task", EntityID: t.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID,
			Title: t.Key + " " + t.Title, Body: t.Description}); err != nil {
			return err
		}
	}
	return nil
}

// indexDocs indexes every live page by its text.
func (r *reindex) indexDocs() error {
	var docs []core.Doc
	if err := r.db.List(r.ctx, &docs, store.Where(store.Live)); err != nil {
		return err
	}
	for _, doc := range docs {
		r.docs[doc.ID] = doc
		var blocks []core.Block
		if err := r.db.List(r.ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", doc.ID), store.Live}, Order: "rank"}); err != nil {
			return err
		}
		var b strings.Builder
		writePlain(&b, BlockTree(blocks))
		if err := r.db.Index(r.ctx, store.SearchDoc{Kind: "doc", EntityID: doc.ID, ScopeType: "doc", ScopeID: doc.ID, ProjectID: doc.ProjectID,
			AudienceID: doc.OwnerID, Title: doc.Title, Body: b.String()}); err != nil {
			return err
		}
	}
	return nil
}

// writePlain writes the plain text of blocks and their children, a line
// each.
func writePlain(b *strings.Builder, blocks []md.Block) {
	for _, bl := range blocks {
		b.WriteString(md.Plain(bl) + "\n")
		writePlain(b, bl.Children)
	}
}

// indexComments indexes the comments on the tasks and pages indexed.
func (r *reindex) indexComments() error {
	var comments []core.Comment
	if err := r.db.List(r.ctx, &comments, store.Where(store.Live)); err != nil {
		return err
	}
	for _, cm := range comments {
		var sd store.SearchDoc
		if t, ok := r.tasks[cm.TaskID]; ok {
			sd = taskCommentEntry(t, cm)
		} else if d, ok := r.docs[cm.DocID]; ok {
			sd = docCommentEntry(d, cm)
		} else {
			continue
		}
		if err := r.db.Index(r.ctx, sd); err != nil {
			return err
		}
	}
	return nil
}

// indexDecisions indexes the decisions on the tasks indexed.
func (r *reindex) indexDecisions() error {
	var decisions []core.Decision
	if err := r.db.List(r.ctx, &decisions, store.Where(store.Live)); err != nil {
		return err
	}
	for _, decision := range decisions {
		t, ok := r.tasks[decision.TaskID]
		if !ok {
			continue
		}
		var opts []core.Option
		if err := r.db.List(r.ctx, &opts, store.Where(store.Eq("decision_id", decision.ID), store.Live)); err != nil {
			return err
		}
		if err := r.db.Index(r.ctx, store.SearchDoc{Kind: "decision", EntityID: decision.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: decision.Question, Body: decisionText(decision.Details, opts)}); err != nil {
			return err
		}
	}
	return nil
}

func (r *reindex) indexEpics() error {
	var epics []core.Epic
	if err := r.db.List(r.ctx, &epics, store.Where(store.Live)); err != nil {
		return err
	}
	for _, ep := range epics {
		if err := r.db.Index(r.ctx, store.SearchDoc{Kind: "epic", EntityID: ep.ID, ScopeType: "epic", ScopeID: ep.ID, ProjectID: ep.ProjectID, Title: ep.Name, Body: ep.Description}); err != nil {
			return err
		}
	}
	return nil
}

// PurgeTrash removes for good what has been in the trash longer than keep.
// It returns the storage keys of the files it removed, for the caller to
// delete from file storage.
func (e *Engine) PurgeTrash(ctx context.Context, keep time.Duration) (purged int, blobKeys []string, err error) {
	run := &purge{ctx: ctx, cutoff: e.now().Add(-keep).UnixMilli()}
	var wss []core.Workspace
	if err := e.st.List(ctx, &wss, store.Where(store.Live)); err != nil {
		return 0, nil, err
	}
	for _, ws := range wss {
		var owner core.Member
		ok, err := store.Find(ctx, e.st.In(ws.ID), &owner, store.Eq("role", string(core.RoleOwner)))
		if err != nil {
			return run.purged, run.blobKeys, err
		}
		if !ok {
			continue
		}
		err = e.System(ctx, ws.ID, owner.UserID, func(s *Sys) error {
			run.c = s.c
			for _, step := range []func() error{run.tasks, run.docs, run.files} {
				if err := step(); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return run.purged, run.blobKeys, err
		}
	}
	return run.purged, run.blobKeys, nil
}

// purge is one run of PurgeTrash: the system write to the workspace being
// purged (c), and what it has removed so far.
type purge struct {
	ctx      context.Context
	c        *cx
	cutoff   int64 // what was trashed at or before this goes
	purged   int
	blobKeys []string
}

// rowsOf names the rows of one table that belong to what is purged.
type rowsOf struct {
	table string
	cond  store.Cond
}

func (run *purge) delete(rows ...rowsOf) error {
	for _, r := range rows {
		if _, err := run.c.tx.Delete(run.ctx, r.table, r.cond); err != nil {
			return err
		}
	}
	return nil
}

// tasks removes tasks trashed before the cutoff with everything on them.
func (run *purge) tasks() error {
	tx := run.c.tx
	tasks, err := tx.Tasks(run.ctx, store.TaskFilter{InTrash: true, Limit: scanLimit})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if t.DeletedAt > run.cutoff {
			continue
		}
		var ds []core.Decision
		if err := tx.List(run.ctx, &ds, store.Where(store.Eq("task_id", t.ID))); err != nil {
			return err
		}
		for _, decision := range ds {
			if err := run.delete(rowsOf{"decision_options", store.Eq("decision_id", decision.ID)}); err != nil {
				return err
			}
		}
		if _, err := tx.Update(run.ctx, "tasks", map[string]any{"parent_id": ""}, store.Eq("parent_id", t.ID)); err != nil {
			return err
		}
		if err := run.delete(rowsOf{"decisions", store.Eq("task_id", t.ID)}, rowsOf{"comments", store.Eq("task_id", t.ID)}, rowsOf{"attachments", store.Eq("task_id", t.ID)},
			rowsOf{"task_labels", store.Eq("task_id", t.ID)}, rowsOf{"task_relations", store.Eq("task_id", t.ID)}, rowsOf{"task_relations", store.Eq("related_task_id", t.ID)},
			rowsOf{"task_links", store.Eq("task_id", t.ID)}, rowsOf{"watchers", store.Eq("subject_id", t.ID)}, rowsOf{"notifications", store.Eq("task_id", t.ID)},
			rowsOf{"refs", store.Eq("from_scope_id", t.ID)}, rowsOf{"refs", store.Eq("to_id", t.ID)}, rowsOf{"tasks", store.Eq("id", t.ID)}); err != nil {
			return err
		}
		if err := run.c.emitDeleted("task", t.ID, inTask(t)); err != nil {
			return err
		}
		run.purged++
	}
	return nil
}

// docs removes pages trashed before the cutoff with everything in them.
func (run *purge) docs() error {
	tx := run.c.tx
	var docs []core.Doc
	if err := tx.List(run.ctx, &docs, store.Where(store.NotNull("deleted_at"), store.Lte("deleted_at", run.cutoff))); err != nil {
		return err
	}
	for _, doc := range docs {
		if _, err := tx.Update(run.ctx, "docs", map[string]any{"parent_id": ""}, store.Eq("parent_id", doc.ID)); err != nil {
			return err
		}
		if err := run.delete(rowsOf{"doc_blocks", store.Eq("doc_id", doc.ID)}, rowsOf{"doc_versions", store.Eq("doc_id", doc.ID)}, rowsOf{"comments", store.Eq("doc_id", doc.ID)},
			rowsOf{"db_properties", store.Eq("database_id", doc.ID)}, rowsOf{"db_views", store.Eq("database_id", doc.ID)}, rowsOf{"attachments", store.Eq("subject_id", doc.ID)},
			rowsOf{"watchers", store.Eq("subject_id", doc.ID)}, rowsOf{"refs", store.Eq("from_scope_id", doc.ID)}, rowsOf{"refs", store.Eq("to_id", doc.ID)}, rowsOf{"docs", store.Eq("id", doc.ID)}); err != nil {
			return err
		}
		if err := run.c.emit(event{seq: tx.NextSeq(), typ: "doc.deleted", entity: "doc", entityID: doc.ID, place: inDoc(doc), audience: docAudience(doc), data: core.EventData{ID: doc.ID, Gone: true}}); err != nil {
			return err
		}
		run.purged++
	}
	return nil
}

// files removes trashed files nothing shows any more, and keeps their
// storage keys for the caller.
func (run *purge) files() error {
	tx := run.c.tx
	var files []core.File
	if err := tx.List(run.ctx, &files, store.Where(store.NotNull("deleted_at"), store.Lte("deleted_at", run.cutoff))); err != nil {
		return err
	}
	for _, f := range files {
		shown, err := tx.Count(run.ctx, "attachments", store.Eq("file_id", f.ID), store.Live)
		if err != nil {
			return err
		}
		if shown > 0 {
			continue
		}
		if err := run.delete(rowsOf{"attachments", store.Eq("file_id", f.ID)}, rowsOf{"files", store.Eq("id", f.ID)}); err != nil {
			return err
		}
		run.blobKeys = append(run.blobKeys, f.StorageKey)
		if f.PreviewKey != "" {
			run.blobKeys = append(run.blobKeys, f.PreviewKey)
		}
		run.purged++
	}
	return nil
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
			for _, t := range slices.Backward(tables) {
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

// AnnounceRestored tells the feed that a task or a page was set back from a
// backup. The rows get new positions in the feed, so every copy that
// compares positions takes them as the newest state, and an open editor
// gets the page's text as it stands now.
func (e *Engine) AnnounceRestored(ctx context.Context, workspaceID, kind, id string) error {
	var owner core.Member
	if err := e.st.In(workspaceID).Get(ctx, &owner, store.Eq("role", string(core.RoleOwner)), store.Null("removed_at")); err != nil {
		return err
	}
	return e.System(ctx, workspaceID, owner.UserID, func(sys *Sys) error {
		tx := sys.Tx()
		next := tx.Seq() + 1 // the position the next event takes
		if kind == "task" {
			if _, err := tx.Update(ctx, "tasks", map[string]any{"updated_seq": next, "activity_seq": next}, store.Eq("id", id)); err != nil {
				return err
			}
			var t core.Task
			if err := tx.Get(ctx, &t, store.Eq("id", id)); err != nil {
				return err
			}
			if err := sys.c.emit(event{seq: tx.NextSeq(), typ: "task.restored", entity: "task", entityID: t.ID, place: inTask(t),
				data: core.EventData{Row: t, Key: &t.Key, FromBackup: true}}); err != nil {
				return err
			}
			_, err := sys.c.link("task", t.ID, "task", t.ID, t.Title+"\n"+t.Description)
			return err
		}
		if _, err := tx.Update(ctx, "docs", map[string]any{"updated_seq": next, "content_seq": next + 1}, store.Eq("id", id)); err != nil {
			return err
		}
		if _, err := tx.Update(ctx, "doc_blocks", map[string]any{"updated_seq": next + 1}, store.Eq("doc_id", id)); err != nil {
			return err
		}
		var doc core.Doc
		if err := tx.Get(ctx, &doc, store.Eq("id", id)); err != nil {
			return err
		}
		if err := sys.c.emit(event{seq: tx.NextSeq(), typ: "doc.restored", entity: "doc", entityID: doc.ID, place: inDoc(doc), audience: docAudience(doc),
			data: core.EventData{Row: doc, FromBackup: true}}); err != nil {
			return err
		}
		var all []core.Block
		if err := tx.List(ctx, &all, store.Q{Where: []store.Cond{store.Eq("doc_id", doc.ID)}, Order: "rank"}); err != nil {
			return err
		}
		live, gone := []core.Block{}, []string{}
		for _, b := range all {
			if b.DeletedAt != 0 {
				gone = append(gone, b.ID)
			} else {
				live = append(live, b)
			}
		}
		if err := sys.c.emit(event{seq: tx.NextSeq(), typ: "doc.edited", entity: "doc", entityID: doc.ID, place: inDoc(doc), audience: docAudience(doc),
			data: core.EventData{ID: doc.ID, Blocks: &live, Deleted: gone, FromBackup: true,
				Changes: map[string]core.FieldChange{"content_seq": {To: next + 1}}}}); err != nil {
			return err
		}
		// What the page mentions is worked out again from its text as it stands.
		rows, err := LoadBlocks(cxLister{sys.c}, doc.ID)
		if err != nil {
			return err
		}
		return sys.c.afterDocText(doc, newEditor(sys.c, doc, rows))
	})
}
