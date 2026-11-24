package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestSearchFindsWhatTheReaderMayOpen: search finds a page exactly when the
// reader may open it. A private page shared with someone is found by them,
// its words and its comments too, and by nobody else; a page of no project
// is found with a credential limited to some projects, as it opens with one.
func TestSearchFindsWhatTheReaderMayOpen(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		bea, other := s.agentToken(t, "bea"), s.agentToken(t, "other")
		shared := s.change(t, s.owner, "", "doc.create", M{"title": "Salaries", "markdown": "wombat figures\n", "private": true, "shared_with": []string{"@bea"}})["ref"].(string)
		s.change(t, s.owner, "", "comment.create", M{"doc": shared, "body": "numbat remark"})
		open := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "platypus rules\n"})["ref"].(string)
		var limited struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "me", "projects": []string{"SVA"}}, 201, &limited)

		finds := func(token, words, docID string) bool {
			t.Helper()
			return strings.Contains(s.call(t, nil, token, "GET", "/api/v1/w/-/search?q="+words, nil, 200, nil), docID)
		}
		t.Run("a private page shared with the reader", func(t *testing.T) {
			for _, words := range []string{"salaries", "wombat", "numbat"} {
				if !finds(bea, words, shared) {
					t.Fatalf("%q does not find a page shared with the reader", words)
				}
				if finds(other, words, shared) {
					t.Fatalf("%q finds a private page for someone it is not shared with", words)
				}
			}
		})
		t.Run("a page of no project, with a credential limited to projects", func(t *testing.T) {
			s.call(t, nil, limited.Token, "GET", "/api/v1/w/-/docs/"+open, nil, 200, nil)
			if !finds(limited.Token, "platypus", open) {
				t.Fatal("a page the credential opens is not found by it")
			}
		})
	})
}

// TestAQuestionNoLongerNeededIsInTheLogAndNotAnAnswer: the decision log
// lists a question closed as no longer needed among those settled, and as
// itself with state=not_needed, saying so in its line; the answers that
// guide later work (the dashboard's) leave it out.
func TestAQuestionNoLongerNeededIsInTheLogAndNotAnAnswer(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		key := r.task(t, nil)
		d := r.change(t, nil, r.claude, "decision.open", M{"task": key, "question": "Which sky?", "options": []M{{"label": "Day"}, {"label": "Night"}}})["ref"]
		r.change(t, r.owner, "", "decision.close", M{"id": d, "note": "settled in the comments"})
		var listed struct{ Decisions []struct{ ID, State string } }
		r.call(t, r.owner, "", "GET", w+"/decisions?state=not_needed", nil, 200, &listed)
		if len(listed.Decisions) != 1 || listed.Decisions[0].ID != d || listed.Decisions[0].State != "not_needed" {
			t.Fatalf("state=not_needed lists %+v", listed.Decisions)
		}
		r.call(t, r.owner, "", "GET", w+"/decisions", nil, 200, &listed)
		if len(listed.Decisions) != 1 {
			t.Fatalf("the settled questions are %+v", listed.Decisions)
		}
		text := r.call(t, r.owner, "", "GET", w+"/decisions?format=text", nil, 200, nil)
		if !strings.Contains(text, `"Which sky?" -> no longer needed: settled in the comments`) {
			t.Fatalf("the log says\n%s", text)
		}
		var dash struct {
			Decisions []struct{ ID string } `json:"recent_decisions"`
		}
		answered := r.change(t, nil, r.claude, "decision.open", M{"task": key, "question": "Which boss?", "options": []M{{"label": "Big"}, {"label": "Small"}}})["ref"]
		r.change(t, r.owner, "", "decision.pick", M{"id": answered, "option": 1})
		r.call(t, r.owner, "", "GET", w+"/dashboard", nil, 200, &dash)
		if len(dash.Decisions) != 1 || dash.Decisions[0].ID != answered {
			t.Fatalf("the dashboard's recent answers are %+v, want only %s", dash.Decisions, answered)
		}
	})
}
