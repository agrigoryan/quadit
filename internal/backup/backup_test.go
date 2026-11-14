package backup_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

type M = map[string]any

// fill makes a small workspace with a bit of everything and returns it.
func fill(t *testing.T, st store.Store, files blob.Store) (core.Workspace, core.User, *engine.Engine) {
	t.Helper()
	ctx := context.Background()
	e := engine.New(st)
	ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", WorkspaceSlug: "games", WorkspaceName: "Games"})
	if err != nil {
		t.Fatal(err)
	}
	do := func(typ string, args any) *engine.Result {
		t.Helper()
		raw, _ := json.Marshal(args)
		res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: typ, Args: raw})
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		return res
	}
	do("project.create", M{"key": "SVA", "name": "Samurai vs Alien", "settings": M{"cycles": true}})
	do("agent.create", M{"name": "Artist", "handle": "artist"})
	do("label.create", M{"name": "art", "project": "SVA"})
	do("task.create", M{"project": "SVA", "title": "Explosion effect", "assignee": "@artist", "labels": []string{"art"}, "description": "Make it **big**."})
	do("task.create", M{"project": "SVA", "title": "Sub-task", "parent": "SVA-1"})
	// A file, attached to an option of a decision.
	f := core.File{ID: id.New(), WorkspaceID: ws.ID, Name: "ring.png", ContentType: "image/png", Size: 9, State: "ready", UploadedBy: owner.ID, CreatedAt: 1}
	f.StorageKey = ws.ID + "/" + f.ID
	if err := files.Put(ctx, f.StorageKey, strings.NewReader("PNG bytes"), "image/png"); err != nil {
		t.Fatal(err)
	}
	if err := st.In(ws.ID).Insert(ctx, f); err != nil {
		t.Fatal(err)
	}
	do("decision.open", M{"task": "SVA-1", "question": "Which explosion?", "ask": "@artist",
		"options": []M{{"label": "ring", "attachments": []M{{"file": f.ID}}}, {"label": "burst"}}})
	do("comment.create", M{"task": "SVA-1", "body": "No rings please, @artist."})
	do("doc.create", M{"title": "Design", "markdown": "# Design\n\nThree phases.\n\n- one\n- two\n"})
	return ws, owner, e
}

func TestBackupMovesBetweenDatabases(t *testing.T) {
	testdb.Each(t, func(t *testing.T, src store.Store) {
		ctx := context.Background()
		srcFiles, _ := blob.NewDisk(t.TempDir())
		ws, owner, _ := fill(t, src, srcFiles)
		var archive bytes.Buffer
		if _, err := backup.Write(ctx, src, srcFiles, "test", &archive); err != nil {
			t.Fatal(err)
		}
		m, err := backup.Verify(bytes.NewReader(archive.Bytes()))
		if err != nil || len(m.Entries) < 40 {
			t.Fatalf("verify: %v (%d entries)", err, len(m.Entries))
		}
		// One flipped byte in the middle and it no longer verifies.
		bad := append([]byte(nil), archive.Bytes()...)
		bad[len(bad)/2] ^= 0xff
		if _, err := backup.Verify(bytes.NewReader(bad)); err == nil {
			t.Fatal("a damaged archive verified")
		}

		// Restore onto every kind of database, whatever kind made the archive.
		testdb.Each(t, func(t *testing.T, dst store.Store) {
			dstFiles, _ := blob.NewDisk(t.TempDir())
			if _, err := backup.Restore(ctx, dst, dstFiles, bytes.NewReader(archive.Bytes())); err != nil {
				t.Fatalf("restore %s -> %s: %v", src.Dialect(), dst.Dialect(), err)
			}
			for _, tb := range store.Tables() {
				a, _ := src.Count(ctx, tb.Name)
				b, _ := dst.Count(ctx, tb.Name)
				if a != b {
					t.Errorf("%s: %d rows before, %d after", tb.Name, a, b)
				}
			}
			var task core.Task
			if err := dst.In(ws.ID).Get(ctx, &task, store.Eq("key", "SVA-1")); err != nil || task.Description != "Make it **big**." || len(task.LabelIDs) != 1 {
				t.Fatalf("task after restore = %+v, %v", task, err)
			}
			r, _, err := dstFiles.Open(ctx, func() string {
				var f core.File
				dst.In(ws.ID).Get(ctx, &f, store.Eq("name", "ring.png"))
				return f.StorageKey
			}())
			if err != nil {
				t.Fatal(err)
			}
			got, _ := io.ReadAll(r)
			r.Close()
			if string(got) != "PNG bytes" {
				t.Fatalf("file after restore = %q", got)
			}
			// The restored install works: the next change continues the sequence.
			e := engine.New(dst)
			if err := e.Reindex(ctx, ws.ID); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(M{"project": "SVA", "title": "After the restore"})
			res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "task.create", Args: raw})
			if err != nil || res.Key != "SVA-3" {
				t.Fatalf("first change after restore: %+v, %v", res, err)
			}
			if hits, _ := dst.In(ws.ID).Search(ctx, store.SearchQuery{Text: "explosion", Viewer: owner.ID}); len(hits) == 0 {
				t.Fatal("search is empty after reindex")
			}
			// A second restore into the same database is refused.
			if _, err := backup.Restore(ctx, dst, dstFiles, bytes.NewReader(archive.Bytes())); err == nil {
				t.Fatal("restore over existing data was accepted")
			}
		})
	})
}

func TestRestoreOneTask(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		ctx := context.Background()
		files, _ := blob.NewDisk(t.TempDir())
		ws, owner, e := fill(t, st, files)
		var archive bytes.Buffer
		if _, err := backup.Write(ctx, st, files, "test", &archive); err != nil {
			t.Fatal(err)
		}
		// The task is deleted and, a month later, purged for good.
		raw, _ := json.Marshal(M{"id": "SVA-1"})
		if _, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "task.delete", Args: raw}); err != nil {
			t.Fatal(err)
		}
		if n, _, err := e.PurgeTrash(ctx, -time.Hour); err != nil || n < 1 {
			t.Fatalf("purge = %d, %v", n, err)
		}
		db := st.In(ws.ID)
		if n, _ := db.Count(ctx, "tasks", store.Eq("key", "SVA-1")); n != 0 {
			t.Fatal("the task survived the purge")
		}
		if n, _ := db.Count(ctx, "comments"); n != 0 {
			t.Fatal("the task's comments survived the purge")
		}
		var sub core.Task
		if err := db.Get(ctx, &sub, store.Eq("key", "SVA-2")); err != nil || sub.ParentID != "" {
			t.Fatalf("sub-task after its parent was purged: %+v, %v", sub, err)
		}
		// One command brings it back, with its decision, comment and file.
		rid, err := backup.RestoreItem(ctx, st, files, bytes.NewReader(archive.Bytes()), backup.Item{Workspace: "games", Kind: "task", Ref: "sva-1"})
		if err != nil {
			t.Fatal(err)
		}
		var task core.Task
		if err := db.Get(ctx, &task, store.Eq("id", rid)); err != nil || task.Key != "SVA-1" || task.DeletedAt != 0 {
			t.Fatalf("restored task = %+v, %v", task, err)
		}
		for table, want := range map[string]int{"decisions": 1, "decision_options": 2, "comments": 1, "attachments": 1} {
			if n, _ := db.Count(ctx, table); n != want {
				t.Errorf("%s after restore = %d, want %d", table, n, want)
			}
		}
		// Bringing it back twice changes nothing.
		if _, err := backup.RestoreItem(ctx, st, files, bytes.NewReader(archive.Bytes()), backup.Item{Workspace: "games", Kind: "task", Ref: "SVA-1"}); err != nil {
			t.Fatal(err)
		}
		if n, _ := db.Count(ctx, "comments"); n != 1 {
			t.Fatalf("a second restore duplicated rows: %d comments", n)
		}
		// A task edited since the backup is set back to how it was, and keeps
		// what was added to it since.
		was := task.Title
		for typ, args := range map[string]M{
			"task.update":    {"id": "SVA-1", "title": "Edited after the backup", "priority": 1},
			"comment.create": {"task": "SVA-1", "body": "Said after the backup."},
		} {
			raw, _ := json.Marshal(args)
			if _, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: typ, Args: raw}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := backup.RestoreItem(ctx, st, files, bytes.NewReader(archive.Bytes()), backup.Item{Workspace: "games", Kind: "task", Ref: "SVA-1"}); err != nil {
			t.Fatal(err)
		}
		var back core.Task
		if err := db.Get(ctx, &back, store.Eq("key", "SVA-1")); err != nil || back.Title != was || back.Priority != task.Priority || back.UpdatedSeq <= task.UpdatedSeq-1000 {
			t.Fatalf("an edited task after restore = %+v (title was %q), %v", back, was, err)
		}
		if n, _ := db.Count(ctx, "comments"); n != 2 {
			t.Fatalf("comments after restoring an edited task = %d, want the old one and the new one", n)
		}
		// A page comes back reading as it did: its text set back, and what
		// was written since in the page's trash.
		raw, _ = json.Marshal(M{"title": "Plan", "markdown": "first line\n\nsecond line\n"})
		res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "doc.create", Args: raw})
		if err != nil {
			t.Fatal(err)
		}
		var archive2 bytes.Buffer
		if _, err := backup.Write(ctx, st, files, "test", &archive2); err != nil {
			t.Fatal(err)
		}
		raw, _ = json.Marshal(M{"doc": res.Ref, "markdown": "first line, rewritten\n\nsecond line\n\na third line\n"})
		if _, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "doc.write", Args: raw}); err != nil {
			t.Fatal(err)
		}
		if _, err := backup.RestoreItem(ctx, st, files, bytes.NewReader(archive2.Bytes()), backup.Item{Workspace: "games", Kind: "doc", Ref: res.Ref}); err != nil {
			t.Fatal(err)
		}
		var live []core.Block
		if err := db.List(ctx, &live, store.Q{Where: []store.Cond{store.Eq("doc_id", res.Ref), store.Live}, Order: "rank"}); err != nil {
			t.Fatal(err)
		}
		text := ""
		for _, b := range live {
			text += string(b.Content) + "|"
		}
		if len(live) != 2 || strings.Contains(text, "rewritten") || strings.Contains(text, "third") || !strings.Contains(text, "first line") {
			t.Fatalf("a page after restore reads: %s", text)
		}
		if _, err := backup.RestoreItem(ctx, st, files, bytes.NewReader(archive.Bytes()), backup.Item{Workspace: "games", Kind: "task", Ref: "SVA-99"}); err == nil {
			t.Fatal("a task that is not in the archive was 'restored'")
		}
	})
}
