package server_test

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/testdb"
)

// What legitimately differs from one run to the next: ids, moments, places
// in the feed, the port the test server listens on.
var shapeVaries = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`), "ID"},
	{regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z`), "TIME"},
	{regexp.MustCompile(`\d{4}-\d\d-\d\d \d\d:\d\d`), "TIME"},
	{regexp.MustCompile(`\b1\d{12}\b`), "TIME"},
	{regexp.MustCompile(`("week": ?)"\d{4}-\d\d-\d\d"`), `$1"WEEK"`},
	{regexp.MustCompile(`("[a-z_]*seq": ?)\d+`), "${1}0"},
	{regexp.MustCompile(`localhost:\d+`), "localhost:PORT"},
}

func shapeOf(s string) string {
	for _, v := range shapeVaries {
		s = v.re.ReplaceAllString(s, v.with)
	}
	return s
}

// shapeJSON is an answer in JSON, indented and without what varies.
func shapeJSON(t *testing.T, raw string) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Indent(&b, []byte(raw), "", " "); err != nil {
		t.Fatalf("%v: %s", err, raw)
	}
	return shapeOf(strings.TrimSpace(b.String()))
}

// TestDashboardAndExportShape holds the dashboard and the export to exactly
// what they answer for one small workspace: the dashboard as JSON and as
// text, and every entry of the export's archive in order, with its size
// and SHA-256. It runs on SQLite only: several of the lists in the export
// are read in whatever order the database keeps them.
func TestDashboardAndExportShape(t *testing.T) {
	t.Parallel()
	s := newSite(t, testdb.SQLite(t))
	const owner = "@aram"

	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
	s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
	s.change(t, s.owner, "", "label.create", M{"name": "art", "project": "SVA"})
	s.change(t, s.owner, "", "epic.create", M{"project": "SVA", "name": "Boss fight", "target_on": "2020-01-01", "lead": owner})
	s.change(t, s.owner, "", "epic.create", M{"project": "SVA", "name": "Polish"})

	// Tasks of the two projects are made in turn, so the order they were
	// made in is not the order of their keys.
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design", "description": "Four phases.\n\nThe last one flies.",
		"epic": "Boss fight", "assignee": "@artist", "waiting_on": owner, "priority": 2, "labels": []string{"art"}, "estimate": 3, "due_on": "2020-02-01"})
	s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss music", "epic": "Boss fight", "estimate": 2})
	s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Back up: nightly/weekly?", "assignee": "@artist", "waiting_on": "@artist"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion effect", "epic": "Boss fight", "parent": "SVA-1", "assignee": "@artist"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Old idea", "epic": "Polish"})
	s.change(t, s.owner, "", "task.update", M{"id": "SVA-2", "status": "done"})
	s.change(t, s.owner, "", "task.update", M{"id": "SVA-3", "status": "in progress"})
	s.change(t, s.owner, "", "task.update", M{"id": "SVA-4", "status": "canceled"})

	// Two decisions on one task, asked by the agent: one answered, one
	// still asked of the owner.
	var tok struct{ Token string }
	s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
	d := s.change(t, nil, tok.Token, "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "details": "It is seen from far away.",
		"options": []M{{"label": "Ring", "description": "one clean ring"}, {"label": "Burst"}}, "recommended": 1})["ref"].(string)
	s.change(t, s.owner, "", "decision.pick", M{"id": d, "option": 2, "note": "reads better small"})
	s.change(t, nil, tok.Token, "decision.open", M{"task": "SVA-1", "question": "How many phases?", "options": []M{{"label": "Three"}, {"label": "Four"}}, "ask": owner})
	s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "No rings please."})
	s.change(t, nil, tok.Token, "comment.create", M{"task": "SVA-1", "body": "Drew the burst.", "kind": "result",
		"evidence": M{"checked": "at 1x and 2x", "measured": "12 frames", "not_verified": "on a phone"}})
	s.change(t, s.owner, "", "preference.create", M{"body": "Explosions are always ring-shaped"})

	// Pages: a tree, two of one name, and a database with its rows.
	book := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "# Handbook\n\nHow we work.\n"})["ref"].(string)
	s.change(t, s.owner, "", "doc.create", M{"parent": book, "title": "Release Notes", "markdown": "v0.1\n\n- a boss\n- a song\n"})
	s.change(t, s.owner, "", "doc.create", M{"title": "Notes", "markdown": "The first.\n"})
	s.change(t, s.owner, "", "doc.create", M{"title": "Notes", "markdown": "The second.\n"})
	db := s.change(t, s.owner, "", "doc.create", M{"title": "Sprites", "kind": "database"})["ref"].(string)
	s.change(t, s.owner, "", "property.create", M{"database": db, "name": "State", "type": "select"})
	s.change(t, s.owner, "", "property.create", M{"database": db, "name": "Frames", "type": "number"})
	s.change(t, s.owner, "", "doc.create", M{"parent": db, "title": "Boss idle", "props": M{"State": "drawn", "Frames": 8}})
	s.change(t, s.owner, "", "doc.create", M{"parent": db, "title": "Boss attack", "props": M{"State": "todo", "Frames": 12}, "markdown": "Wind up, then strike.\n"})

	// A file, uploaded whole and put on a task.
	data := bytes.Repeat([]byte("quadit "), 1000)
	var f struct{ ID, State string }
	s.call(t, s.owner, "", "POST", fmt.Sprintf(w+"/files?name=notes.txt&size=%d", len(data)), data, 201, &f)
	if f.State != "ready" {
		t.Fatalf("upload = %+v", f)
	}
	s.change(t, s.owner, "", "attachment.add", M{"task": "SVA-1", "file": f.ID})

	for _, c := range []struct{ name, got, want string }{
		{"dashboard as JSON", shapeJSON(t, s.call(t, s.owner, "", "GET", w+"/dashboard", nil, 200, nil)), shapeDashboardJSON},
		{"dashboard as text", shapeOf(s.call(t, s.owner, "", "GET", w+"/dashboard?format=text", nil, 200, nil)), shapeDashboardText},
		{"dashboard of one project as JSON", shapeJSON(t, s.call(t, s.owner, "", "GET", w+"/dashboard?project=OPS", nil, 200, nil)), shapeDashboardOPS},
		{"dashboard of one project as text", shapeOf(s.call(t, s.owner, "", "GET", w+"/dashboard?project=OPS&format=text", nil, 200, nil)), shapeDashboardOPSText},
	} {
		if c.got != c.want {
			t.Errorf("%s changed:\n%s", c.name, c.got)
		}
	}

	resp, err := s.owner.Get(s.url + w + "/export")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	head := resp.Header.Get("Content-Type") + "; " + regexp.MustCompile(`\d{4}-\d\d-\d\d`).ReplaceAllString(resp.Header.Get("Content-Disposition"), "DAY")
	if resp.StatusCode != http.StatusOK || head != `application/zip; attachment; filename="games-DAY.zip"` {
		t.Fatalf("export: status %d, %s", resp.StatusCode, head)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Split(strings.TrimSpace(shapeExport), "\n")
	for i, zf := range zr.File {
		rc, err := zf.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		// An uploaded file is kept byte for byte; everything else is text
		// that names ids and moments.
		if !strings.HasPrefix(zf.Name, "files/") {
			body = []byte(shapeOf(string(body)))
		}
		how := "deflated"
		if zf.Method == zip.Store {
			how = "stored"
		}
		line := fmt.Sprintf("%s | %s | %d | %x", shapeOf(zf.Name), how, len(body), sha256.Sum256(body))
		switch {
		case i >= len(want):
			t.Errorf("export has an entry too many: %s", line)
		case line != want[i]:
			t.Errorf("export entry %d changed:\n got %s\nwant %s", i+1, line, want[i])
		default:
			continue
		}
		if !strings.HasPrefix(zf.Name, "files/") {
			t.Logf("%s holds:\n%s", zf.Name, body)
		}
	}
	if len(zr.File) < len(want) {
		t.Errorf("export has %d entries, want %d", len(zr.File), len(want))
	}
}

// What the code answered before the dashboard and the export were taken
// apart into their parts.
const shapeDashboardJSON = `{
 "agents": [
  {
   "handle": "@artist",
   "name": "Artist",
   "user_id": "ID",
   "state": "has_work",
   "connected_at": "TIME",
   "listening": false,
   "listeners": [],
   "listening_projects": [],
   "listening_outside_projects": false,
   "last_seen": "TIME",
   "last_action": "comment.create SVA-1",
   "open_tasks": 3,
   "waiting_on_it": 1
  }
 ],
 "asked_of_me": [
  {
   "n": 1,
   "id": "ID",
   "task": "SVA-1",
   "task_id": "ID",
   "kind": "choice",
   "question": "How many phases?",
   "state": "open",
   "by": "@artist",
   "asked": "@aram",
   "options": [
    {
     "n": 1,
     "id": "ID",
     "label": "Three"
    },
    {
     "n": 2,
     "id": "ID",
     "label": "Four"
    }
   ],
   "asked_at": "TIME"
  }
 ],
 "epics": [
  {
   "id": "ID",
   "name": "Boss fight",
   "project": "SVA",
   "state": "planned",
   "lead": "@aram",
   "target_on": "2020-01-01",
   "total": 3,
   "done": 1,
   "started": 1,
   "points": 5,
   "points_done": 2,
   "at_risk": "past its target date",
   "at_risk_code": "past_target"
  },
  {
   "id": "ID",
   "name": "Polish",
   "project": "SVA",
   "state": "planned",
   "total": 0,
   "done": 0,
   "started": 0
  }
 ],
 "flow": {
  "by_status": [
   {
    "status": "Backlog",
    "category": "backlog",
    "project": "SVA",
    "count": 0
   },
   {
    "status": "Todo",
    "category": "unstarted",
    "project": "SVA",
    "count": 1
   },
   {
    "status": "In Progress",
    "category": "started",
    "project": "SVA",
    "count": 1
   },
   {
    "status": "Waiting",
    "category": "waiting",
    "project": "SVA",
    "count": 0
   },
   {
    "status": "Done",
    "category": "done",
    "project": "SVA",
    "count": 1
   },
   {
    "status": "Canceled",
    "category": "canceled",
    "project": "SVA",
    "count": 1
   },
   {
    "status": "Backlog",
    "category": "backlog",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Todo",
    "category": "unstarted",
    "project": "OPS",
    "count": 2
   },
   {
    "status": "In Progress",
    "category": "started",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Waiting",
    "category": "waiting",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Done",
    "category": "done",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Canceled",
    "category": "canceled",
    "project": "OPS",
    "count": 0
   }
  ],
  "waiting": [
   {
    "member": "@aram",
    "kind": "person",
    "tasks": 1,
    "avg_hours": 0,
    "oldest_hours": 0
   },
   {
    "member": "@artist",
    "kind": "agent",
    "tasks": 1,
    "avg_hours": 0,
    "oldest_hours": 0
   }
  ],
  "weekly": [
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 6,
    "closed": 1
   }
  ]
 },
 "health": {
  "deliveries_dead": 0,
  "deliveries_pending": 0,
  "sources_failing": 0,
  "webhooks_failing": 0
 },
 "preferences": [
  {
   "id": "ID",
   "body": "Explosions are always ring-shaped",
   "created_by": "ID",
   "created_at": TIME,
   "updated_seq": 0
  }
 ],
 "recent_decisions": [
  {
   "n": 1,
   "id": "ID",
   "task": "SVA-1",
   "task_id": "ID",
   "kind": "choice",
   "question": "Which explosion?",
   "details": "It is seen from far away.",
   "state": "picked",
   "by": "@artist",
   "asked": "@aram",
   "options": [
    {
     "n": 1,
     "id": "ID",
     "label": "Ring",
     "description": "one clean ring"
    },
    {
     "n": 2,
     "id": "ID",
     "label": "Burst"
    }
   ],
   "recommended": 1,
   "picked": 2,
   "picked_label": "Burst",
   "outcome": "with_changes",
   "note": "reads better small",
   "decided_by": "@aram",
   "decided_at": "TIME",
   "asked_at": "TIME"
  }
 ],
 "waiting_on_me": [
  {
   "key": "SVA-1",
   "title": "Boss design",
   "status": "Todo",
   "category": "unstarted",
   "priority": "high",
   "assignee": "@artist",
   "waiting_on": "@aram",
   "waiting_on_note": "review the result",
   "labels": [
    "art"
   ],
   "epic": "Boss fight",
   "due_on": "2020-02-01",
   "estimate": 3,
   "seq": 0,
   "updated_seq": 0
  }
 ]
}`

const shapeDashboardText = `== waiting on you (1)
SVA-1  [Todo]  !high  @artist  waits on @aram  Boss design  #art  due 2020-02-01
== epics
SVA  Boss fight  1/3 done  target 2020-01-01  AT RISK: past its target date
SVA  Polish  0/0 done
== status
SVA Todo: 1
SVA In Progress: 1
SVA Done: 1
SVA Canceled: 1
OPS Todo: 2
== waiting longest
@aram  1 tasks, oldest 0.0h, average 0.0h
@artist  1 tasks, oldest 0.0h, average 0.0h
== agents
@artist  has work 
== health
{"deliveries_dead":0,"deliveries_pending":0,"sources_failing":0,"webhooks_failing":0}
`

const shapeDashboardOPS = `{
 "agents": [
  {
   "handle": "@artist",
   "name": "Artist",
   "user_id": "ID",
   "state": "has_work",
   "connected_at": "TIME",
   "listening": false,
   "listeners": [],
   "listening_projects": [],
   "listening_outside_projects": false,
   "last_seen": "TIME",
   "open_tasks": 1,
   "waiting_on_it": 1
  }
 ],
 "asked_of_me": [],
 "epics": [],
 "flow": {
  "by_status": [
   {
    "status": "Backlog",
    "category": "backlog",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Todo",
    "category": "unstarted",
    "project": "OPS",
    "count": 2
   },
   {
    "status": "In Progress",
    "category": "started",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Waiting",
    "category": "waiting",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Done",
    "category": "done",
    "project": "OPS",
    "count": 0
   },
   {
    "status": "Canceled",
    "category": "canceled",
    "project": "OPS",
    "count": 0
   }
  ],
  "waiting": [
   {
    "member": "@artist",
    "kind": "agent",
    "tasks": 1,
    "avg_hours": 0,
    "oldest_hours": 0
   }
  ],
  "weekly": [
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 0,
    "closed": 0
   },
   {
    "week": "WEEK",
    "opened": 2,
    "closed": 0
   }
  ]
 },
 "health": {
  "deliveries_dead": 0,
  "deliveries_pending": 0,
  "sources_failing": 0,
  "webhooks_failing": 0
 },
 "preferences": [
  {
   "id": "ID",
   "body": "Explosions are always ring-shaped",
   "created_by": "ID",
   "created_at": TIME,
   "updated_seq": 0
  }
 ],
 "recent_decisions": [],
 "waiting_on_me": []
}`

const shapeDashboardOPSText = `== waiting on you (0)
nothing
== epics
== status
OPS Todo: 2
== waiting longest
@artist  1 tasks, oldest 0.0h, average 0.0h
== agents
@artist  has work 
== health
{"deliveries_dead":0,"deliveries_pending":0,"sources_failing":0,"webhooks_failing":0}
`

// One line per entry of the archive, in the archive's order: name, how it
// is kept, size and SHA-256 of what it holds.
const shapeExport = `
README.txt | deflated | 705 | d5b732b4d9a9139d7f738562f7ec1e6cf4e8effb96421f59172f5fc9e8842929
data/members.json | deflated | 843 | 204b799549f9013aa666f436aac76769af74f40578ae0e48303053c2935f817d
data/projects.json | deflated | 344 | 1a512062438cf547ca5c3ca4e586922b433dbae258976396509ef55816a7ad50
data/statuses.json | deflated | 2838 | 70b6511306b0abb9d5c2d487ff55e0596e7f149115dd8ec320856d898bbe21af
data/labels.json | deflated | 186 | 5afec1d856b7b74c848122bcaca2602a31349fc6eadf9b5f9e51944c3f7e81f2
data/epics.json | deflated | 434 | 90027cc39c7286519cdc0db8cd6db9b1b459f9c6370a24cfc5fc932d6e600f58
data/milestones.json | deflated | 3 | 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
data/cycles.json | deflated | 3 | 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
data/decisions.json | deflated | 705 | 0e2fce5956f1179076d4ae847073291fb700c47204b67b6e3d5794a4ef7e260a
data/decision_options.json | deflated | 384 | d0d76e369ce4efa60d0c35e8a8f0077f90021f118a35b11a15eed1235eb0bffc
data/comments.json | deflated | 554 | 2a92c685293980c1b5ea3c84de8b99fae8fac37a7e192e00bd0f69388f696546
data/relations.json | deflated | 3 | 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
data/links.json | deflated | 3 | 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
data/attachments.json | deflated | 177 | d408def82bbfb089f48d4a37566a9260fa80f8f263d9c21a21db33c84ce17f2b
data/files.json | deflated | 274 | a9176cd7c243f8e94d3d70ef3b4ab60a3e180888cf6468c420ee7a3ca0cf1392
data/docs.json | deflated | 1759 | ab3e9fcf0d81bd39e45b4e6e669a7ae48165f17efe174ab2b37b723123318b57
data/blocks.json | deflated | 1993 | 77ebc0696a952604ce6d641b9ceacc6085b72fb35cb18d5993341f8a64bd0e39
data/properties.json | deflated | 397 | be182b84fd472a4df5f7d24cde2617677310c71a2619c15ddf0278836402e6ce
data/preferences.json | deflated | 134 | 24085cc7c3325fa74f3db6d810f23fc525110007139aca3048b1ddb24680ee02
data/views.json | deflated | 3 | 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
data/tasks.json | deflated | 2312 | e3f0e10264f8fd8d9f14defa6a7f07c18ab66c84dc0599a042c7731db627a68b
data/events.json | deflated | 40243 | 41832977a15c42800d22cd0115770ce150d2574eedd551ecb7c69b0f485bcfec
tasks/SVA/SVA-1 Boss design.md | deflated | 731 | 5d296083ad02d6137e3286fcbd56d91dabae98b173d0bb44f46e3d86e43dafef
tasks/SVA/SVA-2 Boss music.md | deflated | 139 | d991d93cc46ce7ed7bea1d59521d4a9f5d5ba75d5747e9e5316bd34fbd30250e
tasks/SVA/SVA-3 Explosion effect.md | deflated | 176 | 34046b56614aed05d3b99776206bf73d6dea854f8a1079c9637db83e6d8cc8a1
tasks/SVA/SVA-4 Old idea.md | deflated | 119 | a52ea5df4af229e03df71fd03f677ba618033e1831e99d69944490779de6b31d
tasks/OPS/OPS-1 Rotate keys.md | deflated | 106 | 4a64542e51ab459d901eafbd09a3d174a51fdea5bdddb6b387701aa4212a5cd2
tasks/OPS/OPS-2 Back up- nightly-weekly-.md | deflated | 174 | 10f8e26a05ac66eb144211a0c9c3aa71a8bba58553d7086001fbf9aeeb7a7634
docs/Handbook.md | deflated | 25 | 174d3268471551b2471b2f180f75623869fe79b04ccfbc4f391888b02e25b4fa
docs/Handbook/Release Notes.md | deflated | 24 | 5142e1c8288f7457550c39519e4b07fea7b21763e97f23466c5d06fdd434869b
docs/Sprites/Boss idle.md | deflated | 1 | 01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b
docs/Notes.md | deflated | 11 | 376bf476844a628532fb4b9c5822b6cf8a3b872caabc5c0a85fe7ceb26acaa81
docs/Sprites/Boss attack.md | deflated | 22 | 8f5e299735d880dab8ee274ac4e93c80af81dc871ca447ae87b87117ea5d43e5
docs/Notes (2).md | deflated | 12 | aa18381515cddd8f1dca04330e11d99c29b882417e27b3fbe6806a86b9c389cf
docs/Sprites.csv | deflated | 57 | f32ba14fa7b659f62c90f155c2a7e6bbb83ebd5a4946642b4b269a7f1ef41117
files/ID/notes.txt | stored | 7000 | cdb31fe5aa519d4b02c908f722a9e24a18aaa6458599506ba6b5797057fe29a8
`
