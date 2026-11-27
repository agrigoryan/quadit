package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestDocs(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &tok)
		agent := tok.Token
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})

		// An agent writes a page as Markdown and reads it back the same.
		page := "# Boss\n\nThree phases. See SVA-1 and ask @aram.\n\n- laser\n- drones\n\n## Notes\n\nKeep it readable.\n"
		doc := s.change(t, nil, agent, "doc.create", M{"title": "Boss fight", "markdown": page})["ref"].(string)
		if got := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+doc+"?format=md", nil, 200, nil); got != page {
			t.Fatalf("page came back changed:\n%s", got)
		}
		// The mention reached the owner's inbox; the task knows the page links to it.
		if out := s.call(t, s.owner, "", "GET", w+"/inbox?format=text", nil, 200, nil); !strings.Contains(out, "mentioned: Boss fight") {
			t.Fatalf("owner inbox = %s", out)
		}
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1/context?format=text", nil, 200, nil); !strings.Contains(out, "Boss fight") {
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
			s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+doc, nil, 200, &out)
			m := map[string]string{}
			for _, b := range out.Blocks {
				m[string(b.Content)] = b.ID
			}
			return m
		}
		before := blocks()
		// Rewriting the page with one paragraph changed keeps every other block.
		s.change(t, nil, agent, "doc.write", M{"doc": doc, "markdown": strings.Replace(page, "Keep it readable.", "Keep it readable at 1x.", 1)})
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
		s.change(t, s.owner, "", "doc.edit", M{"doc": doc, "ops": []M{{"op": "insert", "after": heading,
			"block": M{"type": "paragraph", "content": []M{{"type": "text", "text": "Added by a person."}}}}}})
		got := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+doc+"?format=md", nil, 200, nil)
		if !strings.Contains(got, "## Notes\n\nAdded by a person.\n\nKeep it readable at 1x.") {
			t.Fatalf("insert landed in the wrong place:\n%s", got)
		}
		// Versions: keep one, wreck the page, put it back.
		s.change(t, s.owner, "", "doc.snapshot", M{"doc": doc, "label": "good"})
		s.change(t, nil, agent, "doc.write", M{"doc": doc, "markdown": "Oops.\n"})
		var vs struct {
			Versions []struct{ ID, Label string }
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+doc+"/versions", nil, 200, &vs)
		var good string
		for _, v := range vs.Versions {
			if v.Label == "good" {
				good = v.ID
			}
		}
		s.change(t, s.owner, "", "doc.revert", M{"doc": doc, "version": good})
		if back := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+doc+"?format=md", nil, 200, nil); back != got {
			t.Fatalf("revert did not restore the page:\n%s", back)
		}
		// Search reaches page text.
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/search?q=readable&format=text", nil, 200, nil); !strings.Contains(out, "Boss fight") {
			t.Fatalf("search = %s", out)
		}

		// A private page does not exist for anyone else, in reads or the feed.
		secret := s.change(t, s.owner, "", "doc.create", M{"title": "Salary notes", "private": true, "markdown": "confidential"})["ref"].(string)
		s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+secret, nil, 404, nil)
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/events?limit=2000", nil, 200, nil); strings.Contains(out, "Salary") {
			t.Fatal("a private page leaked into another member's feed")
		}
		if out := s.call(t, nil, agent, "GET", "/api/v1/w/-/search?q=confidential", nil, 200, nil); strings.Contains(out, secret) {
			t.Fatal("a private page leaked into another member's search")
		}

		// A database: typed columns, a formula, rows written by name.
		db := s.change(t, s.owner, "", "doc.create", M{"title": "Sprites", "kind": "database"})["ref"].(string)
		for _, p := range []M{{"name": "State", "type": "select"}, {"name": "Frames", "type": "number"}, {"name": "Done", "type": "checkbox"},
			{"name": "Cost", "type": "formula", "config": M{"formula": `if(prop("Done"), 0, prop("Frames") * 2)`}}} {
			p["database"] = db
			s.change(t, s.owner, "", "property.create", p)
		}
		s.change(t, nil, agent, "doc.create", M{"parent": db, "title": "Boss idle", "props": M{"State": "drawn", "Frames": 8, "done": true}})
		s.change(t, nil, agent, "doc.create", M{"parent": db, "title": "Boss attack", "props": M{"State": "todo", "Frames": 12}})
		out := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+db+"/rows?format=text&sort=-Frames", nil, 200, nil)
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if len(lines) != 4 || !strings.HasPrefix(lines[2], "| Boss attack | todo | 12 |  | 24 |") || !strings.HasPrefix(lines[3], "| Boss idle | drawn | 8 | true | 0 |") {
			t.Fatalf("rows:\n%s", out)
		}
		if f := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+db+"/rows?format=text&filter=State:is:todo", nil, 200, nil); strings.Contains(f, "Boss idle") || !strings.Contains(f, "Boss attack") {
			t.Fatalf("filtered rows:\n%s", f)
		}
		if e := s.call(t, nil, agent, "POST", "/api/v1/w/-/changes", M{"id": "0192f0c0-0000-7000-8000-000000000001", "type": "doc.create",
			"args": M{"parent": db, "title": "x", "props": M{"Framez": 1}}}, 400, nil); !strings.Contains(e, `"nearest":"Frames"`) {
			t.Fatalf("misspelled property: %s", e)
		}

		// The decision log is a page built from the data.
		ask := s.change(t, nil, agent, "decision.open", M{"task": "SVA-1", "question": "Two phases or three?", "options": []M{{"label": "Two"}, {"label": "Three"}}})
		s.change(t, s.owner, "", "decision.pick", M{"id": ask["ref"], "option": "Three", "note": "more drama"})
		log := s.change(t, s.owner, "", "doc.create", M{"title": "Decision log", "generated": "decision_log"})["ref"].(string)
		if out := s.call(t, s.owner, "", "GET", w+"/docs/"+log+"?format=md", nil, 200, nil); !strings.Contains(out, "Two phases or three? → **Three**") || !strings.Contains(out, "more drama") {
			t.Fatalf("decision log:\n%s", out)
		}
		s.call(t, s.owner, "", "POST", w+"/changes", M{"id": "0192f0c0-0000-7000-8000-000000000002", "type": "doc.write", "args": M{"doc": log, "markdown": "mine"}}, 409, nil)

		// An agent's memory: notes it writes and reads back, which people can open.
		s.call(t, nil, agent, "POST", "/api/v1/w/-/memory", M{"title": "Preferences", "markdown": "- the owner dislikes rings\n"}, 201, nil)
		s.call(t, nil, agent, "POST", "/api/v1/w/-/memory", M{"title": "Preferences", "markdown": "- bursts read well small\n", "mode": "append"}, 200, nil)
		mem := s.call(t, nil, agent, "GET", "/api/v1/w/-/memory?format=text", nil, 200, nil)
		if !strings.Contains(mem, "# Preferences") || !strings.Contains(mem, "dislikes rings") || !strings.Contains(mem, "bursts read well") {
			t.Fatalf("memory:\n%s", mem)
		}
		if tree := s.call(t, s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil); !strings.Contains(tree, "Writer: memory [memory]") || !strings.Contains(tree, "  Preferences") {
			t.Fatalf("page tree:\n%s", tree)
		}
		_ = block{}
	})
}

func TestSharedPagesChipsAndUndo(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Other", "handle": "other"})
		var wt, ot struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &wt)
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &ot)
		feed := func(token string) string {
			return s.call(t, nil, token, "GET", "/api/v1/w/-/events?limit=2000&types=doc.created,doc.updated,doc.edited", nil, 200, nil)
		}

		// A private page shared with one member: they follow it live, and
		// get the whole page the moment it is shared; nobody else sees it.
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Plans", "private": true, "markdown": "first\n"})["ref"].(string)
		if strings.Contains(feed(wt.Token), page) {
			t.Fatal("a private page was in another member's feed before it was shared")
		}
		s.change(t, s.owner, "", "doc.update", M{"id": page, "shared_with": []string{"@writer"}})
		s.change(t, s.owner, "", "doc.write", M{"doc": page, "markdown": "first\n\nsecond\n"})
		got := feed(wt.Token)
		if !strings.Contains(got, `"title":"Plans"`) || !strings.Contains(got, "doc.edited") {
			t.Fatalf("the member it was shared with does not follow the page: %s", got)
		}
		if strings.Contains(feed(ot.Token), page) {
			t.Fatal("a shared private page leaked to a member it was not shared with")
		}
		s.call(t, nil, wt.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 200, nil)
		s.call(t, nil, ot.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 404, nil)

		// Taking the page back tells that member, and only them, to let it go.
		s.change(t, s.owner, "", "doc.update", M{"id": page, "shared_with": []string{}})
		gone := func(token string) string {
			return s.call(t, nil, token, "GET", "/api/v1/w/-/events?limit=2000&types=doc.unshared", nil, 200, nil)
		}
		if got := gone(wt.Token); !strings.Contains(got, page) || !strings.Contains(got, `"gone":true`) {
			t.Fatalf("the member was not told the page is no longer shared: %s", got)
		}
		if strings.Contains(gone(ot.Token), page) {
			t.Fatal("another member heard about a page that was never theirs")
		}
		s.call(t, nil, wt.Token, "GET", "/api/v1/w/-/docs/"+page, nil, 404, nil)

		// A block with a mention chip and a task chip, as the editor stores it.
		chips := s.change(t, s.owner, "", "doc.create", M{"title": "Chips", "blocks": []M{
			{"id": "0192f0c0-0000-7000-8000-00000000000a", "type": "paragraph", "content": []M{{"type": "text", "text": "Ask "},
				{"type": "mention", "props": M{"handle": "writer"}}, {"type": "text", "text": " about "}, {"type": "task", "props": M{"key": "SVA-1"}}}},
			{"id": "0192f0c0-0000-7000-8000-00000000000b", "type": "paragraph", "content": []M{{"type": "text", "text": "Second."}}},
		}})["ref"].(string)
		md := s.call(t, nil, wt.Token, "GET", "/api/v1/w/-/docs/"+chips+"?format=md", nil, 200, nil)
		if !strings.Contains(md, "Ask @writer about SVA-1") {
			t.Fatalf("chips as Markdown: %s", md)
		}
		// An agent writes the page back with one line changed: the chip block
		// is the same words, so it keeps its id and its chips.
		s.change(t, nil, wt.Token, "doc.write", M{"doc": chips, "markdown": strings.Replace(md, "Second.", "Second, edited.", 1)})
		var out struct {
			Blocks []struct {
				ID      string
				Content json.RawMessage
			}
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+chips, nil, 200, &out)
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
		s.change(t, s.owner, "", "doc.edit", M{"doc": chips, "ops": []M{{"op": "delete", "id": "0192f0c0-0000-7000-8000-00000000000a"}}})
		s.change(t, s.owner, "", "doc.edit", M{"doc": chips, "ops": []M{{"op": "insert", "before": out.Blocks[len(out.Blocks)-1].ID,
			"block": M{"id": "0192f0c0-0000-7000-8000-00000000000a", "type": "paragraph", "content": []M{{"type": "text", "text": "Back again."}}}}}})
		if back := s.call(t, s.owner, "", "GET", w+"/docs/"+chips+"?format=md", nil, 200, nil); !strings.HasPrefix(back, "Back again.") {
			t.Fatalf("the block did not come back in place: %s", back)
		}
		// The page trash can be listed.
		s.change(t, s.owner, "", "doc.delete", M{"id": chips})
		if tr := s.call(t, s.owner, "", "GET", w+"/docs?trash=1", nil, 200, nil); !strings.Contains(tr, `"title":"Chips"`) {
			t.Fatalf("page trash: %s", tr)
		}
	})
}

func TestRenameOption(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		db := s.change(t, s.owner, "", "doc.create", M{"title": "Sprites", "kind": "database"})["ref"].(string)
		state := s.change(t, s.owner, "", "property.create", M{"database": db, "name": "State", "type": "select"})["ref"].(string)
		tags := s.change(t, s.owner, "", "property.create", M{"database": db, "name": "Tags", "type": "multi_select"})["ref"].(string)
		s.change(t, s.owner, "", "doc.create", M{"parent": db, "title": "Boss idle", "props": M{"State": "todo", "Tags": []string{"boss", "todo"}}})
		s.change(t, s.owner, "", "doc.create", M{"parent": db, "title": "Boss attack", "props": M{"State": "drawn"}})
		gone := s.change(t, s.owner, "", "doc.create", M{"parent": db, "title": "Old idea", "props": M{"State": "todo"}})["ref"].(string)
		s.change(t, s.owner, "", "doc.delete", M{"id": gone})
		view := s.change(t, s.owner, "", "dbview.create", M{"database": db, "name": "To draw", "type": "table",
			"config": M{"filters": []M{{"prop": state, "op": "is", "value": "todo"}}}})["ref"].(string)

		res := s.change(t, s.owner, "", "property.update", M{"id": state, "rename_option": M{"from": "todo", "to": "to draw"}})
		_ = res
		rows := s.call(t, s.owner, "", "GET", w+"/docs/"+db+"/rows?format=text", nil, 200, nil)
		if !strings.Contains(rows, "to draw") || !strings.Contains(rows, "drawn") {
			t.Fatalf("rows after the rename: %s", rows)
		}
		// The other property's option of the same name is left alone.
		var out struct {
			Rows []struct {
				Title  string
				Values map[string]any
			}
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+db+"/rows", nil, 200, &out)
		for _, r := range out.Rows {
			if r.Title == "Boss idle" && (r.Values["State"] != "to draw" || fmt.Sprint(r.Values["Tags"]) != "[boss todo]") {
				t.Fatalf("Boss idle after the rename: %+v", r.Values)
			}
		}
		_ = tags
		// The saved view still finds the row, by the new name.
		if v := s.call(t, s.owner, "", "GET", w+"/docs/"+db+"/rows?format=text&view=To+draw", nil, 200, nil); !strings.Contains(v, "Boss idle") || strings.Contains(v, "Boss attack") {
			t.Fatalf("the view after the rename: %s", v)
		}
		_ = view
		// A row in the trash comes back with the new name too.
		s.change(t, s.owner, "", "doc.restore", M{"id": gone})
		if v := s.call(t, s.owner, "", "GET", w+"/docs/"+db+"/rows?format=text&filter=State:is:to+draw", nil, 200, nil); !strings.Contains(v, "Old idea") {
			t.Fatalf("the restored row kept the old name: %s", v)
		}
		// Everyone following along hears of each row.
		if ev := s.call(t, s.owner, "", "GET", w+"/events?types=doc.updated,dbview.updated,property.updated&limit=100", nil, 200, nil); strings.Count(ev, `to draw`) < 4 {
			t.Fatalf("events of the rename: %s", ev)
		}
		// Refusals: a name already taken, an option that is not there, not a select.
		s.call(t, s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "property.update", "args": M{"id": state, "rename_option": M{"from": "to draw", "to": "drawn"}}}, 409, nil)
		s.call(t, s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "property.update", "args": M{"id": state, "rename_option": M{"from": "nope", "to": "x"}}}, 400, nil)
	})
}

// TestOverwrittenEditStaysInHistory checks the co-editing rule: when two
// members change the same block the last one wins, and the other's words
// can still be found in the page's history.
func TestOverwrittenEditStaysInHistory(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
		var wt struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &wt)
		block := "0192f0c0-0000-7000-8000-0000000000b1"
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Plan", "blocks": []M{{"id": block, "type": "paragraph", "content": []M{{"type": "text", "text": "The first draft."}}}}})["ref"].(string)
		edit := func(token, text string) {
			var hc *http.Client
			if token == "" {
				hc = s.owner
			}
			s.change(t, hc, token, "doc.edit", M{"doc": page, "ops": []M{{"op": "update", "id": block, "content": []M{{"type": "text", "text": text}}}}})
		}
		edit(wt.Token, "The agent's careful rewrite.")
		edit("", "The owner's quick overwrite.")
		// The page reads as the last edit says.
		if md := s.call(t, s.owner, "", "GET", w+"/docs/"+page+"?format=md", nil, 200, nil); !strings.Contains(md, "quick overwrite") {
			t.Fatalf("the page: %s", md)
		}
		// And the overwritten words are in a kept version, under their author.
		var vs struct {
			Versions []struct {
				ID        string
				CreatedBy string `json:"created_by"`
			}
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+page+"/versions", nil, 200, &vs)
		found := false
		for _, v := range vs.Versions {
			if out := s.call(t, s.owner, "", "GET", w+"/docs/"+page+"/versions/"+v.ID, nil, 200, nil); strings.Contains(out, "careful rewrite") {
				found = true
			}
		}
		if !found {
			t.Fatalf("the overwritten edit is in none of the %d kept versions", len(vs.Versions))
		}
	})
}

// TestDecisionsAndTitlesAsLinks checks that a decision and a page title can
// be mentioned, and that the task says where it and its decisions are named.
func TestDecisionsAndTitlesAsLinks(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss music"})
		d := s.change(t, s.owner, "", "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "options": []M{{"label": "Ring"}, {"label": "Burst"}}})["ref"].(string)
		guide := s.change(t, s.owner, "", "doc.create", M{"title": "Art guide", "markdown": "Sprites are 32px.\n"})["ref"].(string)
		s.change(t, s.owner, "", "doc.create", M{"title": "Plan", "markdown": "See [[Art guide]]. The explosion was settled in SVA-1#1 and decision:" + d + ".\n"})
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-2", "body": "Match the pick in SVA-1#1."})
		var detail struct {
			MentionedIn []struct {
				FromScopeType string `json:"from_scope_type"`
				ToType        string `json:"to_type"`
				ToID          string `json:"to_id"`
				Title, Key    string
			} `json:"mentioned_in"`
		}
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &detail)
		var inPlan, inTask bool
		for _, m := range detail.MentionedIn {
			inPlan = inPlan || (m.ToType == "decision" && m.ToID == d && m.Title == "Plan")
			inTask = inTask || (m.ToType == "decision" && m.Key == "SVA-2")
		}
		if !inPlan || !inTask {
			t.Fatalf("where the decision is mentioned: %+v", detail.MentionedIn)
		}
		var page struct {
			MentionedIn []struct {
				FromScopeID string `json:"from_scope_id"`
			} `json:"mentioned_in"`
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+guide, nil, 200, &page)
		if len(page.MentionedIn) != 1 {
			t.Fatalf("a page named by its title in brackets: %+v", page.MentionedIn)
		}
	})
}

// TestAPageTellsOfMentionsOnlyWhatTheReaderMaySee: a page lists what it
// mentions and what mentions it, and a reader limited to some projects is
// told of neither a task of another project, a page of another project, nor
// someone else's private page, in either direction.
func TestAPageTellsOfMentionsOnlyWhatTheReaderMaySee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		taskID := func(key string) string {
			var shown struct{ Task struct{ ID string } }
			s.call(t, s.owner, "", "GET", w+"/tasks/"+key+"?raw=1", nil, 200, &shown)
			return shown.Task.ID
		}
		sva, ops := taskID("SVA-1"), taskID("OPS-1")
		salaries := s.change(t, s.owner, "", "doc.create", M{"title": "Salaries", "private": true, "markdown": "who earns what"})["ref"].(string)
		runbook := s.change(t, s.owner, "", "doc.create", M{"title": "Runbook", "project": "OPS", "markdown": "rotate"})["ref"].(string)
		handbook := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "See SVA-1 and OPS-1, the [[Runbook]] and [[Salaries]].\n"})["ref"].(string)
		s.change(t, s.owner, "", "doc.write", M{"doc": runbook, "markdown": "As the [[Handbook]] says.\n"})
		s.change(t, s.owner, "", "doc.write", M{"doc": salaries, "markdown": "As the [[Handbook]] says.\n"})

		type mention struct {
			FromScopeID string `json:"from_scope_id"`
			ToID        string `json:"to_id"`
		}
		var page struct {
			Mentions    []mention `json:"mentions"`
			MentionedIn []mention `json:"mentioned_in"`
		}
		ids := func(ms []mention, of func(mention) string) string {
			var out []string
			for _, m := range ms {
				out = append(out, of(m))
			}
			return strings.Join(out, " ")
		}
		to := func(m mention) string { return m.ToID }
		from := func(m mention) string { return m.FromScopeID }

		s.call(t, s.owner, "", "GET", w+"/docs/"+handbook, nil, 200, &page)
		if got := ids(page.Mentions, to); !strings.Contains(got, ops) || !strings.Contains(got, salaries) || !strings.Contains(got, runbook) {
			t.Fatalf("the owner is not told of all the page mentions: %s", got)
		}
		if got := ids(page.MentionedIn, from); !strings.Contains(got, runbook) || !strings.Contains(got, salaries) {
			t.Fatalf("the owner is not told of all that mentions the page: %s", got)
		}

		page.Mentions, page.MentionedIn = nil, nil
		s.call(t, nil, narrow, "GET", w+"/docs/"+handbook, nil, 200, &page)
		got := ids(page.Mentions, to)
		if !strings.Contains(got, sva) {
			t.Fatalf("a reader of SVA is not told the page mentions SVA-1: %s", got)
		}
		for name, id := range map[string]string{"OPS-1": ops, "the OPS runbook": runbook, "a private page": salaries} {
			if strings.Contains(got, id) || strings.Contains(ids(page.MentionedIn, from), id) {
				t.Errorf("a reader of SVA is told of %s by the page's mentions: %+v", name, page)
			}
		}
	})
}

// TestAPageBringsTheFilesOfItsComments: a page read for the editor brings
// the files on its comments and replies, with where to fetch them, beside
// those on the page itself, so its threads show them as soon as it opens.
func TestAPageBringsTheFilesOfItsComments(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		upload := func(name string) string {
			var f struct{ ID string }
			s.call(t, s.owner, "", "POST", w+"/files?name="+name, []byte("the bytes of "+name), 201, &f)
			return f.ID
		}
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Plan", "markdown": "Ship it.\n"})["ref"].(string)
		other := s.change(t, s.owner, "", "doc.create", M{"title": "Other"})["ref"].(string)
		s.change(t, s.owner, "", "attachment.add", M{"doc": page, "file": upload("cover.txt")})
		root := s.change(t, s.owner, "", "comment.create", M{"doc": page, "body": "see", "attachments": []M{{"file": upload("sketch.png")}}})["ref"].(string)
		reply := s.change(t, s.owner, "", "comment.create", M{"parent": root, "body": "and this"})["ref"].(string)
		s.change(t, s.owner, "", "attachment.add", M{"comment": reply, "file": upload("answer.txt")})
		s.change(t, s.owner, "", "comment.create", M{"doc": other, "body": "elsewhere", "attachments": []M{{"file": upload("other.txt")}}})

		var got struct {
			Attachments []struct {
				SubjectType string `json:"subject_type"`
				SubjectID   string `json:"subject_id"`
				File        struct{ Name, URL string }
			}
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+page, nil, 200, &got)
		on := map[string]string{}
		for _, a := range got.Attachments {
			if a.File.URL == "" {
				t.Errorf("%s comes without its address", a.File.Name)
			}
			on[a.File.Name] = a.SubjectType + " " + a.SubjectID
		}
		want := map[string]string{"cover.txt": "doc " + page, "sketch.png": "comment " + root, "answer.txt": "comment " + reply}
		if fmt.Sprint(on) != fmt.Sprint(want) {
			t.Fatalf("the page brings the files %v, want %v", on, want)
		}
	})
}
