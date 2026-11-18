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
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		bea, other := s.agentToken("bea"), s.agentToken("other")
		shared := s.change(s.owner, "", "doc.create", M{"title": "Salaries", "markdown": "wombat figures\n", "private": true, "shared_with": []string{"@bea"}})["ref"].(string)
		s.change(s.owner, "", "comment.create", M{"doc": shared, "body": "numbat remark"})
		open := s.change(s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "platypus rules\n"})["ref"].(string)
		var limited struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "me", "projects": []string{"SVA"}}, 201, &limited)

		finds := func(token, words, docID string) bool {
			t.Helper()
			return strings.Contains(s.call(nil, token, "GET", "/api/v1/w/-/search?q="+words, nil, 200, nil), docID)
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
			s.call(nil, limited.Token, "GET", "/api/v1/w/-/docs/"+open, nil, 200, nil)
			if !finds(limited.Token, "platypus", open) {
				t.Fatal("a page the credential opens is not found by it")
			}
		})
	})
}
