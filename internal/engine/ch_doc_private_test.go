package engine_test

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// searchFinds reports whether search, made for a member, finds a page or a
// comment on it.
func (w *world) searchFinds(viewer, text, docID string) bool {
	w.t.Helper()
	hits, err := w.db().Search(context.Background(), store.SearchQuery{Text: text, Viewer: viewer})
	if err != nil {
		w.t.Fatal(err)
	}
	for _, h := range hits {
		if h.ScopeID == docID {
			return true
		}
	}
	return false
}

// TestPrivacyReachesTheSubPages: who may see a page is who may see the
// pages under it, as when they are made. Making a page private, sharing it,
// taking someone off and making it everyone's again each take along the
// sub-pages that had the page's readers; a sub-page given other readers on
// purpose keeps them. A page moved under a private page takes its readers;
// one moved out stays private.
func TestPrivacyReachesTheSubPages(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		me := w.owner.ID
		other, bea := w.agent("other"), w.agent("bea")
		page := func(by, title, parent string, more M) string {
			args := M{"title": title, "markdown": title + " quokka\n"}
			if parent != "" {
				args["parent"] = parent
			}
			maps.Copy(args, more)
			return w.do(by, "doc.create", args).Ref
		}
		root := page(me, "Plans", "", nil)
		child := page(me, "Q1", root, nil)
		grand := page(me, "Week 1", child, nil)
		apart := page(me, "Only mine", root, nil)
		w.do(me, "doc.update", M{"id": apart, "private": true, "shared_with": []string{"@bea"}})
		beas := page(bea, "Bea's notes", root, M{"private": true})
		gone := page(me, "Old plan", child, nil)
		w.do(me, "doc.delete", M{"id": gone})
		w.do(me, "comment.create", M{"doc": grand, "body": "wombat"})
		readers := func(id string) (string, []string) { d := w.doc(id); return d.OwnerID, d.SharedWith }
		sees := func(who, id string) bool { return engine.CanSeeDoc(w.doc(id), who) }

		t.Run("going private takes the sub-pages along", func(t *testing.T) {
			res := w.do(me, "doc.update", M{"id": root, "private": true})
			for _, id := range []string{root, child, grand, gone} {
				if owner, _ := readers(id); owner != me {
					t.Fatalf("%s has owner %q after the page above it went private", w.doc(id).Title, owner)
				}
				if sees(other, id) {
					t.Fatalf("another member still sees %s", w.doc(id).Title)
				}
			}
			if owner, _ := readers(beas); owner != bea {
				t.Fatalf("Bea's own private page now belongs to %q", owner)
			}
			// Everyone is told, so that each copy can drop the pages; with no
			// more of a page than what changed about who sees it.
			told := map[string]core.Event{}
			for _, ev := range res.Events {
				if ev.Type == "doc.updated" {
					told[ev.EntityID] = ev
				}
			}
			for _, id := range []string{child, grand, gone} {
				ev, ok := told[id]
				if !ok || ev.AudienceID != "" {
					t.Fatalf("%s: the feed told %+v, want one event to everyone", w.doc(id).Title, ev)
				}
			}
			if _, ok := told[apart]; ok {
				t.Fatal("a sub-page that was private already was told again")
			}
			if w.searchFinds(other, "quokka", root) {
				t.Fatal("another member still finds the page that went private by search")
			}
			if w.searchFinds(other, "quokka", grand) || w.searchFinds(other, "wombat", grand) {
				t.Fatal("another member still finds the sub-sub-page, or a comment on it, by search")
			}
			if !w.searchFinds(me, "quokka", grand) || !w.searchFinds(me, "wombat", grand) {
				t.Fatal("its owner no longer finds the sub-sub-page by search")
			}
			// What happens to the page afterwards is the owner's alone.
			later := w.do(me, "doc.update", M{"id": grand, "title": "Week one"})
			for _, ev := range later.Events {
				if ev.AudienceID != me {
					t.Fatalf("a later change of the sub-sub-page is told to %q, want only its owner", ev.AudienceID)
				}
			}
		})

		t.Run("sharing takes the sub-pages along", func(t *testing.T) {
			w.do(me, "doc.update", M{"id": root, "shared_with": []string{"@other"}})
			for _, id := range []string{child, grand} {
				if _, shared := readers(id); !slices.Equal(shared, []string{other}) || !sees(other, id) {
					t.Fatalf("%s is shared with %v, want the page above it's %v", w.doc(id).Title, shared, []string{other})
				}
			}
			if sees(other, apart) {
				t.Fatal("a sub-page made private on its own was shared with the page above it")
			}
			res := w.do(me, "doc.update", M{"id": root, "shared_with": []string{}})
			unshared := map[string]string{}
			for _, ev := range res.Events {
				if ev.Type == "doc.unshared" {
					unshared[ev.EntityID] = ev.AudienceID
				}
			}
			for _, id := range []string{root, child, grand} {
				if sees(other, id) || unshared[id] != other {
					t.Fatalf("%s: taken off the share, the other member sees it %v and was told %q", w.doc(id).Title, sees(other, id), unshared[id])
				}
			}
		})

		t.Run("everyone's again takes the sub-pages along", func(t *testing.T) {
			res := w.do(me, "doc.update", M{"id": root, "private": false})
			for _, id := range []string{root, child, grand, gone} {
				if owner, _ := readers(id); owner != "" {
					t.Fatalf("%s is still private to %q", w.doc(id).Title, owner)
				}
			}
			if owner, _ := readers(apart); owner != me {
				t.Fatal("a sub-page made private on its own became everyone's")
			}
			// Those who see it now for the first time get all of it.
			whole := 0
			for _, ev := range res.Events {
				var data struct{ Row *core.Doc }
				if err := json.Unmarshal(ev.Data, &data); err != nil {
					t.Fatal(err)
				}
				if ev.EntityID == grand && ev.Type == "doc.updated" && ev.AudienceID == "" && data.Row != nil {
					whole++
				}
			}
			if whole != 1 {
				t.Fatalf("the sub-sub-page was told whole %d times, want once", whole)
			}
			if !w.searchFinds(other, "quokka", grand) || !w.searchFinds(other, "wombat", grand) {
				t.Fatal("another member does not find the sub-sub-page again by search")
			}
			if w.searchFinds(other, "quokka", gone) {
				t.Fatal("a page in the trash came into search")
			}
		})

		t.Run("a page moved under a private page takes its readers", func(t *testing.T) {
			private := page(me, "Secret", "", M{"private": true, "shared_with": []string{"@other"}})
			moved := page(me, "Loose", "", nil)
			under := page(me, "Loose child", moved, nil)
			w.do(me, "doc.update", M{"id": moved, "parent": private})
			for _, id := range []string{moved, under} {
				if owner, shared := readers(id); owner != me || !slices.Equal(shared, []string{other}) {
					t.Fatalf("%s moved under a private page has owner %q shared with %v", w.doc(id).Title, owner, shared)
				}
				if sees(bea, id) {
					t.Fatalf("a member the private page is not shared with sees %s", w.doc(id).Title)
				}
			}
			if w.searchFinds(bea, "quokka", under) {
				t.Fatal("a page moved under a private page is still found by others")
			}
			// Moved out, it stays as private as it was: nobody is shown a
			// page because it was moved.
			w.do(me, "doc.update", M{"id": moved, "parent": nil})
			if owner, _ := readers(under); owner != me {
				t.Fatalf("moved out of a private page, its sub-page is private to %q", owner)
			}
			// Someone else's private page is not taken over by moving it.
			w.do(bea, "doc.update", M{"id": beas, "parent": nil})
			theirs := page(bea, "Bea's folder", "", M{"private": true, "shared_with": []string{"@aram"}})
			w.do(me, "doc.update", M{"id": theirs, "parent": nil}) // seen by me, so movable
			w.do(me, "doc.update", M{"id": apart, "parent": theirs})
			if owner, shared := readers(apart); owner != bea || !slices.Equal(shared, []string{me}) {
				t.Fatalf("my page moved into Bea's shared folder has owner %q shared with %v, want Bea's with me", owner, shared)
			}
		})
	})
}

// TestWhatHappensOnAPrivatePageIsToldToItsReaders: comments, files and
// their changes on a private page are told only to those who may see it,
// and someone else cannot put a file on it.
func TestWhatHappensOnAPrivatePageIsToldToItsReaders(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		me, other := w.owner.ID, w.agent("other")
		file := func() string {
			f := core.File{ID: id.New(), WorkspaceID: w.ws.ID, Name: "a.png", ContentType: "image/png", Size: 3, StorageKey: "k/" + id.New(),
				State: core.FileReady, UploadedBy: me, CreatedAt: w.e.Now()}
			if err := st.Write(ctx, w.ws.ID, func(tx store.Tx) error { return tx.Insert(ctx, f) }); err != nil {
				t.Fatal(err)
			}
			return f.ID
		}
		page := w.do(me, "doc.create", M{"title": "Salaries", "private": true}).Ref
		var events []core.Event
		did := func(typ string, args M) string {
			res := w.do(me, typ, args)
			events = append(events, res.Events...)
			return res.Ref
		}
		cm := did("comment.create", M{"doc": page, "body": "who earns what"})
		did("comment.update", M{"id": cm, "body": "who earns what, by month"})
		did("comment.update", M{"id": cm, "resolved": true})
		onPage := did("attachment.add", M{"doc": page, "file": file()})
		did("attachment.add", M{"comment": cm, "file": file()})
		did("attachment.remove", M{"id": onPage})
		did("attachment.restore", M{"id": onPage})
		did("comment.delete", M{"id": cm})
		for _, ev := range events {
			if ev.AudienceID != me {
				t.Errorf("%s on a private page is told to %q, want its owner alone", ev.Type, ev.AudienceID)
			}
		}
		w.refused(engine.CodeNotFound, other, "attachment.add", M{"doc": page, "file": file()})
		mine := w.do(me, "comment.create", M{"doc": page, "body": "again"}).Ref
		w.refused(engine.CodeNotFound, other, "attachment.add", M{"comment": mine, "file": file()})
	})
}

// TestAPageMadePrivateUnderASharedPageHasTheReadersGiven: a page made
// under a private page takes its readers, unless it is made private itself:
// then it has the readers it was given, its maker and those named, and not
// those of the page above as well.
func TestAPageMadePrivateUnderASharedPageHasTheReadersGiven(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		me := w.owner.ID
		other, bea := w.agent("other"), w.agent("bea")
		root := w.do(me, "doc.create", M{"title": "Plans", "private": true, "shared_with": []string{"@other"}}).Ref

		taken := w.doc(w.do(me, "doc.create", M{"parent": root, "title": "Q1"}).Ref)
		if taken.OwnerID != me || !slices.Equal(taken.SharedWith, []string{other}) {
			t.Errorf("a page made under the shared page has owner %q, shared with %v; want the page above's", taken.OwnerID, taken.SharedWith)
		}
		given := w.doc(w.do(me, "doc.create", M{"parent": root, "title": "For Bea", "private": true, "shared_with": []string{"@bea"}}).Ref)
		if given.OwnerID != me || !slices.Equal(given.SharedWith, []string{bea}) {
			t.Errorf("a page made private for Bea under the shared page has owner %q, shared with %v; want shared with Bea alone", given.OwnerID, given.SharedWith)
		}
		alone := w.doc(w.do(me, "doc.create", M{"parent": root, "title": "Mine", "private": true}).Ref)
		if alone.OwnerID != me || len(alone.SharedWith) != 0 {
			t.Errorf("a page made private alone under the shared page has owner %q, shared with %v; want its maker's alone", alone.OwnerID, alone.SharedWith)
		}
	})
}

// TestOnlyTheOwnerChangesWhoSeesAPrivatePage: someone a private page is
// shared with may edit it, but not take it out of private, share it with
// more people or take people off; its owner may.
func TestOnlyTheOwnerChangesWhoSeesAPrivatePage(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		me := w.owner.ID
		bea, other := w.agent("bea"), w.agent("other")
		page := w.do(me, "doc.create", M{"title": "Salaries", "private": true, "shared_with": []string{"@bea"}}).Ref

		w.do(bea, "doc.update", M{"id": page, "title": "Salaries 2026"})
		for name, args := range map[string]M{
			"sharing it with more people": {"id": page, "shared_with": []string{"@bea", "@other"}},
			"taking people off":           {"id": page, "shared_with": []string{}},
			"making it everyone's":        {"id": page, "private": false},
		} {
			w.refused(engine.CodeForbidden, bea, "doc.update", args)
			if d := w.doc(page); d.OwnerID != me || !slices.Equal(d.SharedWith, []string{bea}) {
				t.Fatalf("%s: readers changed by someone it is shared with: owner %q, shared with %v", name, d.OwnerID, d.SharedWith)
			}
		}
		w.do(me, "doc.update", M{"id": page, "shared_with": []string{"@bea", "@other"}})
		if d := w.doc(page); !slices.Contains(d.SharedWith, other) {
			t.Fatalf("the owner could not share their page: %v", d.SharedWith)
		}
	})
}
