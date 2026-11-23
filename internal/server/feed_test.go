package server_test

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestACursorNeverMovesBackUnderConcurrentAcks: acknowledgments of
// different positions sent at the same time leave the cursor at the
// furthest of them, whichever arrives last.
func TestACursorNeverMovesBackUnderConcurrentAcks(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		token := s.agentToken(t, "acker")
		for i := range 30 {
			s.change(t, s.owner, "", "label.create", M{"name": fmt.Sprintf("l%d", i)})
		}
		var me struct {
			Seq int64 `json:"seq"`
		}
		s.call(t, s.owner, "", "GET", w+"/events?limit=2000", nil, 200, &me)
		top := me.Seq
		if top < 30 {
			t.Fatalf("the feed stands at %d, want 30 or more", top)
		}

		for round := range 10 {
			name := fmt.Sprintf("race%d", round)
			var wg sync.WaitGroup
			for seq := int64(1); seq <= top; seq++ {
				wg.Go(func() {
					req, _ := http.NewRequest(http.MethodPut, s.url+"/api/v1/w/-/cursors/"+name, strings.NewReader(fmt.Sprintf(`{"seq":%d}`, seq)))
					req.Header.Set("Authorization", "Bearer "+token)
					req.Header.Set("Content-Type", "application/json")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Error(err)
						return
					}
					resp.Body.Close()
					if resp.StatusCode != http.StatusOK {
						t.Errorf("ack %d: %s", seq, resp.Status)
					}
				})
			}
			wg.Wait()
			var cursor struct {
				Seq int64 `json:"seq"`
			}
			s.call(t, nil, token, "GET", "/api/v1/w/-/cursors/"+name, nil, 200, &cursor)
			if cursor.Seq != top {
				t.Fatalf("after acks of 1 to %d at once the cursor stands at %d", top, cursor.Seq)
			}
		}
	})
}

// TestMyFeedIsOfMyTasks: mine=1 keeps the feed to the caller's own tasks,
// those assigned to them, waiting on them, mentioning them or that they
// watch, and to an agent as to a person, though an agent follows only by
// choice.
func TestMyFeedIsOfMyTasks(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		token := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		for _, task := range []M{
			{"title": "Assigned", "assignee": "@coder"},
			{"title": "Waiting", "waiting_on": "@coder"},
			{"title": "Mentioning", "description": "Ask @coder."},
			{"title": "Watched"},
			{"title": "Someone else's"},
		} {
			task["project"] = "SVA"
			s.change(t, s.owner, "", "task.create", task)
		}
		s.change(t, nil, token, "watch.set", M{"subject": "SVA-4"})
		var page struct {
			Events []struct {
				Data struct {
					Row struct {
						Key string `json:"key"`
					} `json:"row"`
				} `json:"data"`
			} `json:"events"`
		}
		s.call(t, nil, token, "GET", "/api/v1/w/-/events?after=0&mine=1&types=task.created&limit=500", nil, 200, &page)
		var keys []string
		for _, ev := range page.Events {
			keys = append(keys, ev.Data.Row.Key)
		}
		if got := strings.Join(keys, " "); got != "SVA-1 SVA-2 SVA-3 SVA-4" {
			t.Fatalf("the agent's own feed has the tasks %q, want SVA-1 to SVA-4", got)
		}
	})
}
