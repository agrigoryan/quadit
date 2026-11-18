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
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		token := s.agentToken("acker")
		for i := range 30 {
			s.change(s.owner, "", "label.create", M{"name": fmt.Sprintf("l%d", i)})
		}
		var me struct {
			Seq int64 `json:"seq"`
		}
		s.call(s.owner, "", "GET", w+"/events?limit=2000", nil, 200, &me)
		top := me.Seq
		if top < 30 {
			t.Fatalf("the feed stands at %d, want 30 or more", top)
		}

		for round := range 10 {
			name := fmt.Sprintf("race%d", round)
			var wg sync.WaitGroup
			for seq := int64(1); seq <= top; seq++ {
				wg.Go(func() {
					req, _ := http.NewRequest("PUT", s.url+"/api/v1/w/-/cursors/"+name, strings.NewReader(fmt.Sprintf(`{"seq":%d}`, seq)))
					req.Header.Set("Authorization", "Bearer "+token)
					req.Header.Set("Content-Type", "application/json")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Error(err)
						return
					}
					resp.Body.Close()
					if resp.StatusCode != 200 {
						t.Errorf("ack %d: %s", seq, resp.Status)
					}
				})
			}
			wg.Wait()
			var cursor struct {
				Seq int64 `json:"seq"`
			}
			s.call(nil, token, "GET", "/api/v1/w/-/cursors/"+name, nil, 200, &cursor)
			if cursor.Seq != top {
				t.Fatalf("after acks of 1 to %d at once the cursor stands at %d", top, cursor.Seq)
			}
		}
	})
}
