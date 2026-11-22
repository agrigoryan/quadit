package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestADatabaseShowsOnlyTheRowsTheReaderMaySee: a private row of a database
// everyone sees is its owner's. Another member reading the rows does not get
// it, nor its values in the raw cells, nor its title and values through a
// relation and a rollup of another database.
func TestADatabaseShowsOnlyTheRowsTheReaderMaySee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		agent := s.agentToken(t, "writer")
		pay := s.change(t, s.owner, "", "doc.create", M{"title": "Pay", "kind": "database"})["ref"].(string)
		amount := s.change(t, s.owner, "", "property.create", M{"database": pay, "name": "Amount", "type": "number"})["ref"].(string)
		s.change(t, s.owner, "", "doc.create", M{"parent": pay, "title": "Intern", "props": M{"Amount": 10}})
		hidden := s.change(t, s.owner, "", "doc.create", M{"parent": pay, "title": "Chief quokka", "private": true, "props": M{"Amount": 987654}})["ref"].(string)

		teams := s.change(t, s.owner, "", "doc.create", M{"title": "Teams", "kind": "database"})["ref"].(string)
		members := s.change(t, s.owner, "", "property.create", M{"database": teams, "name": "Members", "type": "relation", "config": M{"database": pay}})["ref"].(string)
		s.change(t, s.owner, "", "property.create", M{"database": teams, "name": "Total", "type": "rollup", "config": M{"relation": members, "target": amount, "fn": "sum"}})
		s.change(t, s.owner, "", "doc.create", M{"parent": teams, "title": "Leads", "props": M{"Members": []string{hidden}}})

		t.Run("the rows of the database", func(t *testing.T) {
			for _, q := range []string{"", "?format=text", "?raw=1"} {
				out := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+pay+"/rows"+q, nil, 200, nil)
				if strings.Contains(out, "Chief quokka") || strings.Contains(out, "987654") || strings.Contains(out, hidden) {
					t.Fatalf("rows%s show a private row:\n%s", q, out)
				}
				if q != "?raw=1" && !strings.Contains(out, "Intern") {
					t.Fatalf("rows%s lost the row everyone sees:\n%s", q, out)
				}
			}
			if out := s.call(t, s.owner, "", "GET", w+"/docs/"+pay+"/rows", nil, 200, nil); !strings.Contains(out, "Chief quokka") {
				t.Fatalf("the owner lost their own private row:\n%s", out)
			}
		})
		t.Run("through a relation and a rollup", func(t *testing.T) {
			out := s.call(t, nil, agent, "GET", "/api/v1/w/-/docs/"+teams+"/rows", nil, 200, nil)
			if strings.Contains(out, "Chief quokka") || strings.Contains(out, "987654") {
				t.Fatalf("another database shows a private row's title or value:\n%s", out)
			}
			if out := s.call(t, s.owner, "", "GET", w+"/docs/"+teams+"/rows", nil, 200, nil); !strings.Contains(out, "987654") {
				t.Fatalf("the owner's rollup lost their own private row:\n%s", out)
			}
		})
	})
}
