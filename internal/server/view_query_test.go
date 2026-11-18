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

// TestAViewIsSavedOnlyWithAQueryThatReads holds view.create and view.update
// to what they answer today for a table of queries: each filter a task
// query has with a value that is there, with one that is not, and with one
// of the wrong type. A view that saves is a view that opens, so the check
// made when one is saved is the same reading of the query that a task list
// makes; this records where that line is drawn, in
// testdata/reads/view-queries.golden (see TestEveryReadAnswersEachCallerTheSame
// for how the file is written and compared).
func TestAViewIsSavedOnlyWithAQueryThatReads(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		rw := newRichWorkspace(t, s, st)
		s.change(t, s.owner, "", "label.create", M{"name": "twice", "project": "SVA"})
		s.change(t, s.owner, "", "label.create", M{"name": "twice", "project": "OPS"})
		bea := rw.callers[1].hc
		var out strings.Builder
		n := 0
		// apply sends one change and records what came of it.
		apply := func(who string, hc *http.Client, typ string, args M) {
			raw, _ := json.Marshal(args)
			req, _ := http.NewRequest(http.MethodPost, s.url+w+"/changes", strings.NewReader(fmt.Sprintf(`{"id":%q,"type":%q,"args":%s}`, id.New(), typ, raw)))
			resp, err := hc.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var answer struct {
				Error   json.RawMessage `json:"error"`
				Results []struct {
					Key string `json:"key"`
				} `json:"results"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
				t.Fatalf("%s %s: %v", typ, raw, err)
			}
			said := "saved"
			if len(answer.Results) > 0 && answer.Results[0].Key != "" {
				said = "saved as " + answer.Results[0].Key
			}
			if resp.StatusCode != http.StatusOK {
				said = rw.n.body(answer.Error)
			}
			fmt.Fprintf(&out, "\n=== %s %s %s\n%d\n%s\n", who, typ, rw.n.text(string(raw)), resp.StatusCode, strings.TrimSuffix(said, "\n"))
		}
		// Each query is saved in a new view, then put on a view there already.
		try := func(who string, hc *http.Client, project string, query any) {
			n++
			args := M{"name": fmt.Sprintf("view %d", n), "query": query}
			if project != "" {
				args["project"] = project
			}
			apply(who, hc, "view.create", args)
			target := "art-bugs"
			if project == "OPS" {
				target = "ops-infra"
			}
			if who == "admin" {
				apply(who, hc, "view.update", M{"id": target, "query": query})
			}
		}

		for _, query := range []M{
			// Every filter, with a value that is there.
			{}, {"project": []string{"SVA"}}, {"project": []string{"SVA", "OPS"}}, {"project": []string{rw.id("project OPS")}},
			{"assignee": []string{"me", "none", "@bea"}}, {"creator": "@aram"}, {"creator": "me"},
			{"status": []string{"todo"}}, {"status": []string{"Review"}}, {"status": []string{"started"}}, {"status": []string{rw.id("status Review")}},
			{"category": []string{"started", "done"}}, {"open": true}, {"open": false},
			{"waiting_on": "me"}, {"waiting_on": "@bea"}, {"waiting_on": "outside"}, {"waiting_on": "none"}, {"held_by": "@artist"},
			{"label": []string{"art"}}, {"label": []string{"bug"}}, {"label": []string{"infra"}}, {"label": []string{rw.id("label art")}},
			{"epic": []string{"Boss fight", "none"}}, {"epic": []string{"Hardening"}}, {"epic": []string{rw.id("epic Boss fight")}},
			{"cycle": []string{"current"}}, {"cycle": []string{"next"}}, {"cycle": []string{"none"}}, {"cycle": []string{"1"}}, {"cycle": []string{rw.id("cycle SVA now")}},
			{"milestone": "Alpha"}, {"milestone": rw.id("milestone Audit")},
			{"priority": []int{1, 2}}, {"priority": []int{0}}, {"due_before": "2026-03-31"}, {"due_after": "2026-03-31"},
			{"mentions": "@bea"}, {"mentions": "me"}, {"watching": true}, {"has_open_decision": true}, {"asked": "me"}, {"asked": "@cy"},
			{"changed_since": 5}, {"updated_since": 5}, {"parent": "SVA-1"}, {"parent": rw.id("task OPS-1")}, {"top_level": true}, {"q": "boss"},
			{"keys": []string{"SVA-1", "ops-1"}}, {"trash": true}, {"archived": true}, {"sort": "priority"}, {"sort": "-updated"}, {"limit": 10, "offset": 5},
			{"label": []string{"art"}, "status": []string{"todo"}, "assignee": []string{"me"}, "open": true, "sort": "due"},

			// A name that is not there, or no longer.
			{"project": []string{"NOPE"}}, {"project": []string{"DEL"}}, {"project": []string{"ARC"}},
			{"assignee": []string{"@nobody"}}, {"assignee": []string{"@dee"}}, {"creator": "@nobody"}, {"waiting_on": "@nobody"}, {"held_by": "@nobody"},
			{"mentions": "@nobody"}, {"asked": "@nobody"},
			{"status": []string{"nope"}}, {"status": []string{"todo", "nope"}}, {"category": []string{"nope"}}, {"category": []string{"Started"}},
			{"label": []string{"nope"}}, {"label": []string{"temp"}}, {"label": []string{"gone"}}, {"label": []string{"twice"}}, {"label": []string{"Art"}},
			{"epic": []string{"nope"}}, {"epic": []string{"Scrapped"}}, {"cycle": []string{"99"}}, {"cycle": []string{"nope"}},
			{"milestone": "nope"}, {"milestone": "Removed"}, {"milestone": "Dropped"},
			{"priority": []int{9}}, {"priority": []int{-1}}, {"parent": "NOPE-1"}, {"parent": "SVA-999"}, {"parent": "nonsense"}, {"parent": "SVA-4"},
			{"keys": []string{"SVA-999"}}, {"keys": []string{"nonsense"}}, {"keys": []string{"SVA-1", "NOPE-1"}}, {"sort": "nope"}, {"sort": "-priority"},

			// The wrong type, or a field that is none.
			{"label": "art"}, {"labels": []string{"art"}}, {"status": "todo"}, {"assignee": "me"}, {"epic": "Boss fight"}, {"cycle": 1}, {"project": "SVA"},
			{"open": "yes"}, {"open": 1}, {"watching": "yes"}, {"priority": "high"}, {"priority": []string{"high"}}, {"priority": []float64{1.5}},
			{"due_before": "tomorrow"}, {"due_after": "31/03/2026"}, {"due_before": 20260331},
			{"limit": -1}, {"offset": -1}, {"changed_since": -1}, {"updated_since": -5}, {"limit": "ten"}, {"creator": []string{"me"}}, {"milestone": []string{"Alpha"}},
			{"keys": "SVA-1"}, {"q": 5}, {"view": "mine"}, {"nope": true}, {"Label": []string{"art"}},
		} {
			try("admin", s.owner, "", query)
		}
		for _, query := range []any{[]string{"label"}, "label=art", 12, true, nil} {
			try("admin", s.owner, "", query)
		}

		// With the view in a project: the names are that project's.
		for _, query := range []M{
			{}, {"label": []string{"art"}}, {"label": []string{"infra"}}, {"label": []string{"bug"}}, {"label": []string{"twice"}}, {"status": []string{"Review"}},
			{"epic": []string{"Boss fight"}}, {"epic": []string{"Hardening"}}, {"cycle": []string{"current"}}, {"cycle": []string{"2"}}, {"milestone": "Alpha"},
			{"project": []string{"SVA"}}, {"project": []string{"OPS"}}, {"parent": "SVA-1"}, {"keys": []string{"SVA-1"}},
		} {
			try("admin", s.owner, "SVA", query)
			try("admin", s.owner, "OPS", query)
		}
		try("admin", s.owner, "NOPE", M{})
		try("admin", s.owner, "DEL", M{})

		// By a member limited to one project.
		for _, query := range []M{
			{}, {"project": []string{"SVA"}}, {"project": []string{"OPS"}}, {"project": []string{"SVA", "OPS"}}, {"label": []string{"art"}}, {"label": []string{"infra"}},
			{"label": []string{"bug"}}, {"label": []string{"twice"}}, {"status": []string{"Review"}}, {"epic": []string{"Boss fight"}}, {"epic": []string{"Hardening"}},
			{"cycle": []string{"current"}}, {"milestone": "Alpha"}, {"milestone": "Audit"}, {"parent": "SVA-1"}, {"parent": "OPS-1"}, {"keys": []string{"OPS-1"}},
			{"assignee": []string{"me"}}, {"label": []string{"nope"}},
		} {
			try("member limited to SVA", bea, "", query)
		}
		try("member limited to SVA", bea, "SVA", M{"label": []string{"art"}})
		try("member limited to SVA", bea, "OPS", M{"label": []string{"infra"}})
		try("member limited to SVA", bea, "OPS", M{})

		// A query taken off a view, and one that is not JSON at all.
		apply("admin", s.owner, "view.update", M{"id": "art-bugs", "query": nil})
		apply("admin", s.owner, "view.update", M{"id": "art-bugs", "query": M{"label": []string{"art"}}, "name": "Art"})
		apply("admin", s.owner, "view.update", M{"id": "stale", "name": "Still stale"})
		apply("admin", s.owner, "view.update", M{"id": "stale", "query": M{"label": []string{"temp"}}})
		apply("admin", s.owner, "view.create", M{"name": "no query"})
		apply("admin", s.owner, "view.create", M{"name": "no query, in a project", "project": "OPS"})

		compareWithRecorded(t, "view-queries.golden", out.String())
	})
}
