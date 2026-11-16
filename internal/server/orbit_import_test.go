package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// An Orbit server as release 0.3.0 answers, which is not how the first
// stand-in answered: members carry display_name and user_id and nothing
// else, a status has one of fewer categories and a place in an order, there
// are no milestones or relations, and attached files are handed only to a
// signed-in session on the routes of Orbit's own web app.
func orbitAsItAnswers(t *testing.T, fetched *int) *httptest.Server {
	const ws = "ws1"
	gif := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
	items := func(rw http.ResponseWriter, list ...M) {
		if list == nil {
			list = []M{}
		}
		json.NewEncoder(rw).Encode(M{"items": list, "next_cursor": nil})
	}
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if inner, ok := strings.CutPrefix(r.URL.Path, "/api/v1/workspaces/"+ws); ok {
			if auth != "Bearer orbit-session" { // an API token is refused here
				rw.WriteHeader(http.StatusUnauthorized)
				return
			}
			switch inner {
			case "/tasks/t1/attachments":
				items(rw,
					M{"id": "a1", "task_id": "t1", "comment_id": nil, "display_name": "before.gif", "media_type": "image/gif", "deleted": false},
					M{"id": "a2", "task_id": "t1", "comment_id": "c2", "display_name": "after.gif", "media_type": "image/gif", "deleted": false},
					M{"id": "a3", "task_id": "t1", "comment_id": nil, "display_name": "gone.gif", "deleted": true})
			case "/tasks/t2/attachments":
				items(rw)
			case "/tasks/t1/attachments/a1/download", "/tasks/t1/attachments/a2/download":
				*fetched++
				rw.Header().Set("Content-Type", "image/gif")
				rw.Write(append(append([]byte{}, gif...), inner...)) // each its own bytes
			default:
				rw.WriteHeader(http.StatusNotFound)
			}
			return
		}
		if auth != "Bearer orbit-token" {
			rw.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch strings.TrimPrefix(r.URL.Path, "/api/public/v1/workspaces/"+ws) {
		case "/projects":
			items(rw, M{"id": "p1", "name": "Samurai vs Aliens", "key": "SVA", "color": "#f00"})
		case "/members":
			items(rw, M{"display_name": "Aram", "user_id": "u1"}, M{"display_name": "Claude", "user_id": "u2"})
		case "/projects/p1/statuses":
			// Out of order on purpose: position decides.
			items(rw,
				M{"id": "s5", "name": "Waiting on you", "category": "started", "position": 4, "color": "#f59e0b"},
				M{"id": "s1", "name": "Backlog", "category": "unstarted", "position": 0, "color": "#8b8f98"},
				M{"id": "s2", "name": "Parked", "category": "unstarted", "position": 1},
				M{"id": "s3", "name": "Todo", "category": "unstarted", "position": 2},
				M{"id": "s4", "name": "In Progress", "category": "started", "position": 3},
				M{"id": "s6", "name": "Done", "category": "completed", "position": 5},
				M{"id": "s7", "name": "Cancelled", "category": "cancelled", "position": 6}, //nolint:misspell // Orbit's own words
				M{"id": "s8", "name": "Duplicate", "category": "duplicate", "position": 7})
		case "/projects/p1/labels":
			items(rw, M{"id": "l1", "name": "visual", "color": "#3b82f6"}, M{"id": "l2", "name": "tooling", "color": "#64748b"})
		case "/tasks":
			link := "/api/v1/workspaces/" + ws + "/tasks/t1/attachments/a1/download"
			items(rw,
				M{"id": "t1", "identifier": "SVA-1", "number": 1, "project_id": "p1", "status_id": "s5", "title": "Core fight", "priority": "high",
					"description":  "Before:\n\n![before.gif](" + link + ")\n\nand again ![x](http://" + r.Host + link + ")",
					"assignee_ids": []string{"u1"}, "label_ids": []string{"l1"}, "parent_task_id": nil},
				M{"id": "t2", "identifier": "SVA-2", "number": 2, "project_id": "p1", "status_id": "s4", "title": "Shield", "priority": "none",
					"assignee_ids": []string{"u2"}, "label_ids": []string{}, "parent_task_id": "t1"})
		case "/tasks/SVA-1/comments":
			items(rw,
				M{"id": "c1", "task_id": "t1", "author_id": "u1", "author_service_account": nil, "body": "why the fast walk in?", "created_at": "2026-11-14T07:10:23.233Z"},
				M{"id": "c2", "task_id": "t1", "author_id": "u2", "body": "Because of this: ![after.gif](/api/v1/workspaces/" + ws + "/tasks/t1/attachments/a2/download)", "created_at": "2026-11-14T08:00:00.000Z"})
		case "/tasks/SVA-2/comments":
			items(rw)
		case "/docs":
			items(rw, M{"id": "d1", "parent_id": nil, "title": "Project docs", "kind": "page"}, M{"id": "d2", "parent_id": "d1", "title": "Bosses", "kind": "page"})
		case "/docs/d1":
			json.NewEncoder(rw).Encode(M{"id": "d1", "title": "Project docs", "content": []M{}, "markdown": "A copy of the docs.\n"})
		case "/docs/d2":
			json.NewEncoder(rw).Encode(M{"id": "d2", "title": "Bosses", "content": []M{}, "markdown": "The final boss.\n"})
		default: // milestones, relations: this release has neither
			rw.Header().Set("Content-Type", "application/problem+json")
			rw.WriteHeader(http.StatusNotFound)
			rw.Write([]byte(`{"title":"Route not found","status":404}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestImportFromOrbitAsItAnswers(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		var fetched int
		orbit := orbitAsItAnswers(t, &fetched)
		// The owner is "Aram" here as there; the agent has a longer name
		// here than the "Claude" it had there.
		s.change(s.owner, "", "agent.create", M{"name": "Claude Helper", "handle": "helper"})
		type answer struct {
			Made            map[string]int `json:"made"`
			AlreadyThere    int            `json:"already_there"`
			UnmatchedPeople []string       `json:"unmatched_people"`
			Log             []string       `json:"log"`
		}
		opts := M{"workspace": "ws1", "token": "orbit-token", "session": "orbit-session"}
		var res answer
		s.call(s.owner, "", "POST", w+"/import", M{"kind": "orbit", "source": orbit.URL, "options": opts}, 200, &res)
		if res.Made["tasks"] != 2 || res.Made["comments"] != 2 || res.Made["pages"] != 2 || res.Made["files"] != 2 || len(res.UnmatchedPeople) != 0 {
			t.Fatalf("first run: %+v", res)
		}

		// People are found by the only name Orbit gives, and a comment says
		// who wrote it by name.
		one := s.call(s.owner, "", "GET", w+"/tasks/SVA-1?format=text", nil, 200, nil)
		two := s.call(s.owner, "", "GET", w+"/tasks/SVA-2?format=text", nil, 200, nil)
		if !strings.Contains(one, "@aram") || !strings.Contains(two, "@helper") {
			t.Fatalf("assignees:\n%s\n%s", one, two)
		}
		if !strings.Contains(one, "**Aram**, 2026-11-14") || !strings.Contains(one, "**Claude**, 2026-11-14") || strings.Contains(one, "someone") {
			t.Fatalf("comment authors:\n%s", one)
		}
		// Statuses kept their names; the two Orbit has no kind for got ours.
		if !strings.Contains(one, "Waiting on you") || !strings.Contains(two, "In Progress") || !strings.Contains(two, "SVA-1") {
			t.Fatalf("statuses and parent:\n%s\n%s", one, two)
		}

		// The whole workflow came, used by a task or not, in Orbit's order
		// within each kind, with its colors.
		// The project is new here, so its workflow is exactly Orbit's: every
		// status, used by a task or not, in Orbit's order, each of the right
		// kind; the statuses a new project starts with that Orbit does not
		// have ("Waiting", "Canceled") are gone, and new tasks still start
		// in "Todo".
		var lay struct {
			Statuses []struct {
				Name, Category, Color, Rank string
				IsDefault                   bool   `json:"is_default"`
				DeletedAt                   *int64 `json:"deleted_at"`
			}
			Labels []struct{ Name, Color string }
		}
		s.call(s.owner, "", "GET", w+"/list/statuses", nil, 200, &lay)
		s.call(s.owner, "", "GET", w+"/list/labels", nil, 200, &lay)
		sort.Slice(lay.Statuses, func(i, j int) bool { return lay.Statuses[i].Rank < lay.Statuses[j].Rank })
		all, starts := "", ""
		for _, st := range lay.Statuses {
			if st.DeletedAt != nil && *st.DeletedAt != 0 {
				continue
			}
			all += st.Name + " (" + st.Category + "), "
			if st.IsDefault {
				starts += st.Name
			}
		}
		const want = "Backlog (backlog), Parked (unstarted), Todo (unstarted), In Progress (started), Waiting on you (waiting), Done (done), Cancelled (canceled), Duplicate (canceled), " //nolint:misspell // the name Orbit gave the status, kept
		if all != want || starts != "Todo" {
			t.Fatalf("the workflow:\n got %s\nwant %s\nnew tasks start in %q", all, want, starts)
		}
		labels := map[string]string{}
		for _, l := range lay.Labels {
			labels[l.Name] = l.Color
		}
		if labels["visual"] != "#3b82f6" || labels["tooling"] != "#64748b" {
			t.Fatalf("labels (one of them on no task): %+v", lay.Labels)
		}

		// The pictures live here now: the description and the comment point
		// at this server, without its name, and the files open.
		type shown struct{ ID, Name, URL string }
		var got struct {
			Task        struct{ Description string }
			Attachments []shown
			Comments    []struct {
				Body        string
				Attachments []shown
			}
		}
		s.call(s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, &got)
		desc := got.Task.Description
		if strings.Contains(desc, "/api/v1/workspaces/") || strings.Count(desc, "](/f/") != 2 || strings.Contains(desc, orbit.URL) {
			t.Fatalf("description still points at Orbit, or at this server by name:\n%s", desc)
		}
		// It is SVA-1 here as it was there, so it does not say what it was.
		if strings.Contains(desc, "Was SVA-1") || !strings.Contains(desc, "Imported from") {
			t.Fatalf("the note under the description:\n%s", desc)
		}
		at := strings.Index(desc, "](/f/") + 2
		addr := desc[at : at+strings.Index(desc[at:], ")")]
		if !strings.HasSuffix(addr, "/before.gif") {
			t.Fatalf("picture address: %s", addr)
		}
		if bytes := s.call(s.owner, "", "GET", addr, nil, 200, nil); !strings.HasPrefix(bytes, "GIF89a") || !strings.HasSuffix(bytes, "/a1/download") {
			t.Fatalf("the picture's bytes: %q", bytes)
		}
		if len(got.Attachments) != 1 || got.Attachments[0].Name != "before.gif" {
			t.Fatalf("the task's own files (the deleted one and the comment's are not among them): %+v", got.Attachments)
		}
		var withFile int
		for _, cm := range got.Comments {
			if strings.Contains(cm.Body, "/api/v1/workspaces/") {
				t.Fatalf("a comment still points at Orbit:\n%s", cm.Body)
			}
			if len(cm.Attachments) == 1 && cm.Attachments[0].Name == "after.gif" && strings.Contains(cm.Body, "](/f/") {
				withFile++
			}
		}
		if withFile != 1 {
			t.Fatalf("the comment's file: %+v", got.Comments)
		}
		tree := s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil)
		if !strings.Contains(tree, "Project docs  (") || !strings.Contains(tree, "  Bosses  (") {
			t.Fatalf("pages:\n%s", tree)
		}

		// A second run makes nothing and stores no file a second time.
		count := func() int {
			n, err := st.Count(context.Background(), "files")
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
		before := count()
		var again answer
		s.call(s.owner, "", "POST", w+"/import", M{"kind": "orbit", "source": orbit.URL, "options": opts}, 200, &again)
		if again.Made["tasks"] != 0 || again.Made["comments"] != 0 || again.Made["pages"] != 0 || again.Made["files"] != 0 || count() != before {
			t.Fatalf("second run: %+v, files %d -> %d", again, before, count())
		}

		// Without a session nothing is fetched, and the import says what
		// that means.
		fetched = 0
		var dry answer
		s.call(s.owner, "", "POST", w+"/import", M{"kind": "orbit", "source": orbit.URL, "options": M{"workspace": "ws1", "token": "orbit-token"}}, 200, &dry)
		if fetched != 0 || !strings.Contains(strings.Join(dry.Log, "\n"), "session=TOKEN") {
			t.Fatalf("without a session: fetched %d, log %v", fetched, dry.Log)
		}
		// That run read descriptions that differ from the ones first brought
		// over (they point at Orbit). What is here stays as it was.
		s.call(s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, &got)
		if dry.Made["tasks"] != 0 || got.Task.Description != desc {
			t.Fatalf("a run after the source changed: %+v\n%s", dry, got.Task.Description)
		}
		// An API token in place of the session is refused by Orbit, and the
		// import says which of the two was wrong.
		out := s.call(s.owner, "", "POST", w+"/import", M{"kind": "orbit", "source": orbit.URL, "options": M{"workspace": "ws1", "token": "orbit-token", "session": "orbit-token"}}, 400, nil)
		if !strings.Contains(out, "signed-in Orbit session") {
			t.Fatalf("a wrong session: %s", out)
		}
	})
}

// TestImportIsHistoryNotNews: what an import brings is in the feed, but in
// nobody's inbox, from the server's import and from the command line's.
// Its comment writers who are members here follow their tasks, and the next
// ordinary comment tells them and the rest as usual. Only an admin may send
// a change quiet.
func TestImportIsHistoryNotNews(t *testing.T) {
	for _, from := range []string{"server", "command line"} {
		t.Run(from, func(t *testing.T) {
			st := testdb.SQLite(t)
			s := newSite(t, st)
			var fetched int
			orbit := orbitAsItAnswers(t, &fetched)
			s.change(s.owner, "", "agent.create", M{"name": "Claude Helper", "handle": "helper"})
			var helper struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@helper"}, 201, &helper)
			// Bea, a second person, follows the whole project.
			var inv struct{ Link string }
			s.call(s.owner, "", "POST", w+"/invites", M{"role": "member"}, 201, &inv)
			bea := browser()
			s.call(bea, "", "POST", "/api/v1/auth/invite/"+inv.Link[strings.LastIndex(inv.Link, "/")+1:],
				M{"name": "Bea", "email": "bea@example.com", "password": "another-long-password"}, 200, nil)
			s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Aliens"})
			s.change(bea, "", "watch.set", M{"type": "project", "subject": "SVA"})

			opts := M{"workspace": "ws1", "token": "orbit-token", "session": "orbit-session"}
			if from == "server" {
				s.call(s.owner, "", "POST", w+"/import", M{"kind": "orbit", "source": orbit.URL, "options": opts}, 200, nil)
			} else {
				var own struct{ Token string }
				s.call(s.owner, "", "POST", w+"/tokens", M{}, 201, &own)
				if out, code := s.quadit(own.Token, "import", "orbit", orbit.URL, "workspace=ws1", "token=orbit-token", "session=orbit-session"); code != 0 {
					t.Fatalf("quadit import: %d %s", code, out)
				}
			}
			inbox := func(hc *http.Client, token string) string {
				return s.call(hc, token, "GET", w+"/inbox?format=text&all=1", nil, 200, nil)
			}
			if a, b := inbox(nil, helper.Token), inbox(bea, ""); strings.Contains(a, "SVA-") || strings.Contains(b, "SVA-") {
				t.Fatalf("the import reached inboxes:\nhelper: %s\nbea: %s", a, b)
			}
			if n, _ := st.Count(context.Background(), "notifications"); n != 0 {
				t.Fatalf("%d inbox items after the import", n)
			}
			if n, _ := st.Count(context.Background(), "jobs", store.Eq("kind", "notify")); n != 0 {
				t.Fatalf("%d wake-ups after the import", n)
			}
			// The feed has it all, marked as brought in; the assignment and
			// the comment writer's watch are set.
			feed := s.call(s.owner, "", "GET", w+"/events?task=SVA-1&limit=500", nil, 200, nil)
			if !strings.Contains(feed, `"task.created"`) || !strings.Contains(feed, `"comment.created"`) || !strings.Contains(feed, `"quiet":true`) {
				t.Fatalf("the feed: %s", feed)
			}
			var two, one struct {
				Task     struct{ Assignee string }
				Watchers []string
			}
			s.call(s.owner, "", "GET", w+"/tasks/SVA-2", nil, 200, &two)
			s.call(s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, &one)
			if two.Task.Assignee != "@helper" || !strings.Contains(strings.Join(one.Watchers, ","), "@helper") {
				t.Fatalf("assignee %q, watchers of SVA-1 %v", two.Task.Assignee, one.Watchers)
			}

			// News after the import is news again.
			s.change(s.owner, "", "comment.create", M{"task": "SVA-1", "body": "the walk-in stays"})
			if a, b := inbox(nil, helper.Token), inbox(bea, ""); !strings.Contains(a, "SVA-1") || !strings.Contains(b, "SVA-1") {
				t.Fatalf("a comment after the import told nobody:\nhelper: %s\nbea: %s", a, b)
			}

			// A member or an agent may not send a change quiet.
			quiet := M{"changes": []M{{"id": id.New(), "type": "comment.create", "args": M{"task": "SVA-1", "body": "psst"}, "quiet": true}}}
			s.call(bea, "", "POST", w+"/changes", quiet, 403, nil)
			s.call(nil, helper.Token, "POST", w+"/changes", quiet, 403, nil)
		})
	}
}
