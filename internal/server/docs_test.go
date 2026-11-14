package server_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestDocs(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
		var tok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &tok)
		agent := tok.Token
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})

		// An agent writes a page as Markdown and reads it back the same.
		page := "# Boss\n\nThree phases. See SVA-1 and ask @aram.\n\n- laser\n- drones\n\n## Notes\n\nKeep it readable.\n"
		doc := s.change(nil, agent, "doc.create", M{"title": "Boss fight", "markdown": page})["ref"].(string)
		if got := s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+doc+"?format=md", nil, 200, nil); got != page {
			t.Fatalf("page came back changed:\n%s", got)
		}
		// The mention reached the owner's inbox; the task knows the page links to it.
		if out := s.call(s.owner, "", "GET", w+"/inbox?format=text", nil, 200, nil); !strings.Contains(out, "mentioned: Boss fight") {
			t.Fatalf("owner inbox = %s", out)
		}
		if out := s.call(nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1/context?format=text", nil, 200, nil); !strings.Contains(out, "Boss fight") {
			t.Fatalf("context pack misses the linked page: %s", out)
		}

		type block struct {
			ID, Type string
			Plain    string
		}
		blocks := func() map[string]string { // plain text -> block id
			var out struct {
				Blocks []struct {
					ID      string
					Content json.RawMessage
				}
			}
			s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+doc, nil, 200, &out)
			m := map[string]string{}
			for _, b := range out.Blocks {
				m[string(b.Content)] = b.ID
			}
			return m
		}
		before := blocks()
		// Rewriting the page with one paragraph changed keeps every other block.
		s.change(nil, agent, "doc.write", M{"doc": doc, "markdown": strings.Replace(page, "Keep it readable.", "Keep it readable at 1x.", 1)})
		after := blocks()
		kept, fresh := 0, 0
		for content, bid := range after {
			if before[content] == bid {
				kept++
			} else {
				fresh++
			}
		}
		if kept != len(before)-1 || fresh != 1 {
			t.Fatalf("rewrite kept %d blocks and made %d new ones; want %d and 1", kept, fresh, len(before)-1)
		}
		// A block edit by a person in the editor, placed after a known block.
		var heading string
		for content, bid := range after {
			if strings.Contains(content, "Notes") {
				heading = bid
			}
		}
		s.change(s.owner, "", "doc.edit", M{"doc": doc, "ops": []M{{"op": "insert", "after": heading,
			"block": M{"type": "paragraph", "content": []M{{"type": "text", "text": "Added by a person."}}}}}})
		got := s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+doc+"?format=md", nil, 200, nil)
		if !strings.Contains(got, "## Notes\n\nAdded by a person.\n\nKeep it readable at 1x.") {
			t.Fatalf("insert landed in the wrong place:\n%s", got)
		}
		// Versions: keep one, wreck the page, put it back.
		s.change(s.owner, "", "doc.snapshot", M{"doc": doc, "label": "good"})
		s.change(nil, agent, "doc.write", M{"doc": doc, "markdown": "Oops.\n"})
		var vs struct {
			Versions []struct{ ID, Label string }
		}
		s.call(s.owner, "", "GET", w+"/docs/"+doc+"/versions", nil, 200, &vs)
		var good string
		for _, v := range vs.Versions {
			if v.Label == "good" {
				good = v.ID
			}
		}
		s.change(s.owner, "", "doc.revert", M{"doc": doc, "version": good})
		if back := s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+doc+"?format=md", nil, 200, nil); back != got {
			t.Fatalf("revert did not restore the page:\n%s", back)
		}
		// Search reaches page text.
		if out := s.call(nil, agent, "GET", "/api/v1/w/-/search?q=readable&format=text", nil, 200, nil); !strings.Contains(out, "Boss fight") {
			t.Fatalf("search = %s", out)
		}

		// A private page does not exist for anyone else, in reads or the feed.
		secret := s.change(s.owner, "", "doc.create", M{"title": "Salary notes", "private": true, "markdown": "confidential"})["ref"].(string)
		s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+secret, nil, 404, nil)
		if out := s.call(nil, agent, "GET", "/api/v1/w/-/events?limit=2000", nil, 200, nil); strings.Contains(out, "Salary") {
			t.Fatal("a private page leaked into another member's feed")
		}
		if out := s.call(nil, agent, "GET", "/api/v1/w/-/search?q=confidential", nil, 200, nil); strings.Contains(out, secret) {
			t.Fatal("a private page leaked into another member's search")
		}

		// A database: typed columns, a formula, rows written by name.
		db := s.change(s.owner, "", "doc.create", M{"title": "Sprites", "kind": "database"})["ref"].(string)
		for _, p := range []M{{"name": "State", "type": "select"}, {"name": "Frames", "type": "number"}, {"name": "Done", "type": "checkbox"},
			{"name": "Cost", "type": "formula", "config": M{"formula": `if(prop("Done"), 0, prop("Frames") * 2)`}}} {
			p["database"] = db
			s.change(s.owner, "", "property.create", p)
		}
		s.change(nil, agent, "doc.create", M{"parent": db, "title": "Boss idle", "props": M{"State": "drawn", "Frames": 8, "done": true}})
		s.change(nil, agent, "doc.create", M{"parent": db, "title": "Boss attack", "props": M{"State": "todo", "Frames": 12}})
		out := s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+db+"/rows?format=text&sort=-Frames", nil, 200, nil)
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if len(lines) != 4 || !strings.HasPrefix(lines[2], "| Boss attack | todo | 12 |  | 24 |") || !strings.HasPrefix(lines[3], "| Boss idle | drawn | 8 | true | 0 |") {
			t.Fatalf("rows:\n%s", out)
		}
		if f := s.call(nil, agent, "GET", "/api/v1/w/-/docs/"+db+"/rows?format=text&filter=State:is:todo", nil, 200, nil); strings.Contains(f, "Boss idle") || !strings.Contains(f, "Boss attack") {
			t.Fatalf("filtered rows:\n%s", f)
		}
		if e := s.call(nil, agent, "POST", "/api/v1/w/-/changes", M{"id": "0192f0c0-0000-7000-8000-000000000001", "type": "doc.create",
			"args": M{"parent": db, "title": "x", "props": M{"Framez": 1}}}, 400, nil); !strings.Contains(e, `"nearest":"Frames"`) {
			t.Fatalf("misspelt property: %s", e)
		}

		// The decision log is a page built from the data.
		ask := s.change(nil, agent, "decision.open", M{"task": "SVA-1", "question": "Two phases or three?", "options": []M{{"label": "Two"}, {"label": "Three"}}})
		s.change(s.owner, "", "decision.pick", M{"id": ask["ref"], "option": "Three", "note": "more drama"})
		log := s.change(s.owner, "", "doc.create", M{"title": "Decision log", "generated": "decision_log"})["ref"].(string)
		if out := s.call(s.owner, "", "GET", w+"/docs/"+log+"?format=md", nil, 200, nil); !strings.Contains(out, "Two phases or three? → **Three**") || !strings.Contains(out, "more drama") {
			t.Fatalf("decision log:\n%s", out)
		}
		s.call(s.owner, "", "POST", w+"/changes", M{"id": "0192f0c0-0000-7000-8000-000000000002", "type": "doc.write", "args": M{"doc": log, "markdown": "mine"}}, 409, nil)

		// An agent's memory: notes it writes and reads back, which people can open.
		s.call(nil, agent, "POST", "/api/v1/w/-/memory", M{"title": "Preferences", "markdown": "- the owner dislikes rings\n"}, 201, nil)
		s.call(nil, agent, "POST", "/api/v1/w/-/memory", M{"title": "Preferences", "markdown": "- bursts read well small\n", "mode": "append"}, 200, nil)
		mem := s.call(nil, agent, "GET", "/api/v1/w/-/memory?format=text", nil, 200, nil)
		if !strings.Contains(mem, "# Preferences") || !strings.Contains(mem, "dislikes rings") || !strings.Contains(mem, "bursts read well") {
			t.Fatalf("memory:\n%s", mem)
		}
		if tree := s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil); !strings.Contains(tree, "Writer: memory [memory]") || !strings.Contains(tree, "  Preferences") {
			t.Fatalf("page tree:\n%s", tree)
		}
		_ = block{}
	})
}

func TestSharedPagesChipsAndUndo(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
		s.change(s.owner, "", "agent.create", M{"name": "Other", "handle": "other"})
		var wt, ot struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &wt)
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &ot)
		feed := func(token string) string {
			return s.call(nil, token, "GET", "/api/v1/w/-/events?limit=2000&types=doc.created,doc.updated,doc.edited", nil, 200, nil)
		}

		// A private page shared with one member: they follow it live, and
		// get the whole page the moment it is shared; nobody else sees it.
		page := s.change(s.owner, "", "doc.create", M{"title": "Plans", "private": true, "markdown": "first\n"})["ref"].(string)
		if strings.Contains(feed(wt.Token), page) {
			t.Fatal("a private page was in another member's feed before it was shared")
		}
		s.change(s.owner, "", "doc.update", M{"id": page, "shared_with": []string{"@writer"}})
		s.change(s.owner, "", "doc.write", M{"doc": page, "markdown": "first\n\nsecond\n"})
		got := feed(wt.Token)
		if !strings.Contains(got, `"title":"Plans"`) || !strings.Contains(got, "doc.edited") {
			t.Fatalf("the member it was shared with does not follow the page: %s", got)
		}
		if strings.Contains(feed(ot.Token), page) {
			t.Fatal("a shared private page leaked to a member it was not shared with")
		}
		s.call(nil, wt.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 200, nil)
		s.call(nil, ot.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 404, nil)

		// Taking the page back tells that member, and only them, to let it go.
		s.change(s.owner, "", "doc.update", M{"id": page, "shared_with": []string{}})
		gone := func(token string) string {
			return s.call(nil, token, "GET", "/api/v1/w/-/events?limit=2000&types=doc.unshared", nil, 200, nil)
		}
		if got := gone(wt.Token); !strings.Contains(got, page) || !strings.Contains(got, `"gone":true`) {
			t.Fatalf("the member was not told the page is no longer shared: %s", got)
		}
		if strings.Contains(gone(ot.Token), page) {
			t.Fatal("another member heard about a page that was never theirs")
		}
		s.call(nil, wt.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 404, nil)

		// A block with a mention chip and a task chip, as the editor stores it.
		chips := s.change(s.owner, "", "doc.create", M{"title": "Chips", "blocks": []M{
			{"id": "0192f0c0-0000-7000-8000-00000000000a", "type": "paragraph", "content": []M{{"type": "text", "text": "Ask "},
				{"type": "mention", "props": M{"handle": "writer"}}, {"type": "text", "text": " about "}, {"type": "task", "props": M{"key": "SVA-1"}}}},
			{"id": "0192f0c0-0000-7000-8000-00000000000b", "type": "paragraph", "content": []M{{"type": "text", "text": "Second."}}},
		}})["ref"].(string)
		md := s.call(nil, wt.Token, "GET", "/api/v1/w/-/docs/"+chips+"?format=md", nil, 200, nil)
		if !strings.Contains(md, "Ask @writer about SVA-1") {
			t.Fatalf("chips as Markdown: %s", md)
		}
		// An agent writes the page back with one line changed: the chip block
		// is the same words, so it keeps its id and its chips.
		s.change(nil, wt.Token, "doc.write", M{"doc": chips, "markdown": strings.Replace(md, "Second.", "Second, edited.", 1)})
		var out struct {
			Blocks []struct {
				ID      string
				Content json.RawMessage
			}
		}
		s.call(s.owner, "", "GET", w+"/docs/"+chips, nil, 200, &out)
		kept := false
		for _, b := range out.Blocks {
			if b.ID == "0192f0c0-0000-7000-8000-00000000000a" && strings.Contains(string(b.Content), `"mention"`) {
				kept = true
			}
		}
		if !kept || len(out.Blocks) != 2 {
			t.Fatalf("the chip block was replaced by the rewrite: %+v", out.Blocks)
		}

		// Undo of a delete puts the block back under its own id.
		s.change(s.owner, "", "doc.edit", M{"doc": chips, "ops": []M{{"op": "delete", "id": "0192f0c0-0000-7000-8000-00000000000a"}}})
		s.change(s.owner, "", "doc.edit", M{"doc": chips, "ops": []M{{"op": "insert", "before": out.Blocks[len(out.Blocks)-1].ID,
			"block": M{"id": "0192f0c0-0000-7000-8000-00000000000a", "type": "paragraph", "content": []M{{"type": "text", "text": "Back again."}}}}}})
		if back := s.call(s.owner, "", "GET", w+"/docs/"+chips+"?format=md", nil, 200, nil); !strings.HasPrefix(back, "Back again.") {
			t.Fatalf("the block did not come back in place: %s", back)
		}
		// The page trash can be listed.
		s.change(s.owner, "", "doc.delete", M{"id": chips})
		if tr := s.call(s.owner, "", "GET", w+"/docs?trash=1", nil, 200, nil); !strings.Contains(tr, `"title":"Chips"`) {
			t.Fatalf("page trash: %s", tr)
		}
	})
}
