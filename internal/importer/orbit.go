package importer

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// orbit reads a workspace from an Orbit server through its public API: its
// projects with their statuses and labels, their tasks and comments, and
// its docs. The source is the server's address; it needs workspace=ID and
// token=TOKEN. Orbit hands attached files only to a signed-in session, not
// to an API token: with session=TOKEN they are fetched too (orbit_files.go).
type orbit struct{}

func (orbit) Kind() string { return "orbit" }

func (orbit) Read(origin string, opts Options) (Plan, error) {
	r := &orbitReader{
		origin: strings.TrimRight(origin, "/"), workspace: opts["workspace"], token: opts["token"], session: opts["session"],
		plan: Plan{Source: "orbit"},
		who:  map[string]string{}, called: map[string]string{}, keyOf: map[string]string{},
		statusOf: map[string]Status{}, labelOf: map[string]string{}, milestoneOf: map[string]string{},
	}
	if r.workspace == "" || r.token == "" {
		return r.plan, fmt.Errorf("an Orbit import needs workspace=ID and token=TOKEN (an Orbit API token that can read tasks and docs)")
	}
	if r.session == "" {
		r.plan.Notes = []string{"Orbit hands attached files only to a signed-in session, not to an API token, so they are not brought over: " +
			"pictures in descriptions and comments will point at Orbit. Give session=TOKEN to bring the files too " +
			"(Orbit answers a sign-in sent without an Origin header, POST /api/v1/auth/login, with one)."}
	}
	r.base = r.origin + "/api/public/v1/workspaces/" + url.PathEscape(r.workspace)
	for _, step := range []func() error{r.members, r.projects, r.tasks, r.docs} {
		if err := step(); err != nil {
			return r.plan, err
		}
	}
	return r.plan, nil
}

// orbitReader holds one read of an Orbit workspace: where it is, and what
// has been learnt so far that later steps need.
type orbitReader struct {
	origin, base              string // the server, and its public API for the workspace
	workspace, token, session string
	plan                      Plan

	// People by member id and by user id: who is what a member here is
	// matched by (an email address when Orbit gives one), called is what a
	// person reads.
	who, called map[string]string
	keyOf       map[string]string // project id -> key
	statusOf    map[string]Status // by id
	labelOf     map[string]string // id -> name
	milestoneOf map[string]string // id -> name
}

// orbitList is how Orbit's API answers with a list.
type orbitList[T any] struct {
	Items []T    `json:"items"`
	Next  string `json:"next_cursor"`
}

// orbitCategory gives our kind of status for Orbit's.
var orbitCategory = map[string]string{"backlog": "backlog", "unstarted": "unstarted", "started": "started", "completed": "done",
	"cancelled": "canceled", "canceled": "canceled", "duplicate": "canceled"}

func (r *orbitReader) members() error {
	var members orbitList[struct {
		ID, Name, Email string
		DisplayName     string `json:"display_name"`
		UserID          string `json:"user_id"`
	}]
	getJSON(r.base+"/members", r.token, &members) // names for people, when the token may read them
	for _, m := range members.Items {
		name := orStr(m.DisplayName, m.Name)
		for _, k := range []string{m.ID, m.UserID} {
			if k != "" {
				r.who[k], r.called[k] = orStr(m.Email, name), orStr(name, m.Email)
			}
		}
	}
	return nil
}

func (r *orbitReader) projects() error {
	var projects orbitList[struct{ ID, Name, Key string }]
	if _, err := getJSON(r.base+"/projects", r.token, &projects); err != nil {
		return err
	}
	for _, p := range projects.Items {
		key := KeyFrom(p.Key)
		r.keyOf[p.ID] = p.Key
		r.plan.Projects = append(r.plan.Projects, Project{Key: key, Name: p.Name})
		if err := r.workflow(p.ID, key); err != nil {
			return err
		}
	}
	return nil
}

// workflow reads a project's statuses, labels and milestones.
func (r *orbitReader) workflow(projectID, key string) error {
	at := r.base + "/projects/" + projectID
	var statuses orbitList[struct {
		ID, Name, Category, Type, Color string
		Position                        int
	}]
	if _, err := getJSON(at+"/statuses", r.token, &statuses); err != nil {
		return err
	}
	sort.SliceStable(statuses.Items, func(i, j int) bool { return statuses.Items[i].Position < statuses.Items[j].Position })
	for _, s := range statuses.Items {
		cat := orbitCategory[strings.ToLower(orStr(s.Category, s.Type))]
		// Orbit has fewer kinds of status: its "Backlog" is a status not
		// started, its "Waiting on you" one that is. The name says which
		// of ours it is.
		switch guess := category(s.Name); {
		case cat == "", cat == "unstarted" && guess == "backlog", cat == "started" && guess == "waiting":
			cat = guess
		}
		st := Status{Project: key, Name: s.Name, Category: cat, Color: s.Color}
		r.statusOf[s.ID] = st
		r.plan.Statuses = append(r.plan.Statuses, st)
	}
	var labels orbitList[struct{ ID, Name, Color string }]
	if _, err := getJSON(at+"/labels", r.token, &labels); err == nil {
		for _, l := range labels.Items {
			r.labelOf[l.ID] = l.Name
			r.plan.Labels = append(r.plan.Labels, Label{Project: key, Name: l.Name, Color: l.Color})
		}
	}
	// Orbit's milestones are stages of a project; here they become epics.
	// (A release that has none answers "not found", which is no milestones.)
	var milestones orbitList[struct{ ID, Name string }]
	if _, err := getJSON(at+"/milestones", r.token, &milestones); err == nil {
		for _, m := range milestones.Items {
			r.milestoneOf[m.ID] = m.Name
		}
	}
	return nil
}

type orbitTask struct {
	ID, Title, Description, Priority, Identifier, URL string
	ProjectID                                         string   `json:"project_id"`
	StatusID                                          string   `json:"status_id"`
	AssigneeIDs                                       []string `json:"assignee_ids"`
	LabelIDs                                          []string `json:"label_ids"`
	DueAt                                             string   `json:"due_at"`
	Estimate                                          int
	ParentTaskID                                      string `json:"parent_task_id"`
	MilestoneID                                       string `json:"milestone_id"`
	Number                                            int
}

func (r *orbitReader) tasks() error {
	var all []orbitTask
	for cursor := ""; ; {
		var page orbitList[orbitTask]
		u := r.base + "/tasks?limit=100"
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}
		if _, err := getJSON(u, r.token, &page); err != nil {
			return err
		}
		all = append(all, page.Items...)
		if page.Next == "" || len(page.Items) == 0 {
			break
		}
		cursor = page.Next
	}
	// In the order of their numbers there, so that SVA-12 stays SVA-12 here
	// whenever the project is new on this side.
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].ProjectID != all[j].ProjectID {
			return all[i].ProjectID < all[j].ProjectID
		}
		return all[i].Number < all[j].Number
	})
	for _, ot := range all {
		t, err := r.task(ot)
		if err != nil {
			return err
		}
		r.plan.Tasks = append(r.plan.Tasks, t)
	}
	return nil
}

// task makes one task of the plan, with its relations, comments and files.
func (r *orbitReader) task(ot orbitTask) (Task, error) {
	st := r.statusOf[ot.StatusID]
	t := Task{Ext: ot.ID, Project: KeyFrom(r.keyOf[ot.ProjectID]), Title: ot.Title, Description: ot.Description, Status: st.Name, Category: st.Category,
		Priority: priorityNames[ot.Priority], DueOn: ot.DueAt, Estimate: ot.Estimate, ParentExt: ot.ParentTaskID, URL: ot.URL,
		Epic: r.milestoneOf[ot.MilestoneID], WasKey: ot.Identifier, Number: ot.Number}
	if len(ot.AssigneeIDs) > 0 {
		t.Assignee = orStr(r.who[ot.AssigneeIDs[0]], ot.AssigneeIDs[0])
	}
	for _, l := range ot.LabelIDs {
		if n := r.labelOf[l]; n != "" {
			t.Labels = append(t.Labels, n)
		}
	}
	r.relations(ot, &t)
	commentAt := r.comments(ot, &t)
	if r.session == "" {
		return t, nil
	}
	return t, r.files(ot, &t, commentAt)
}

// relations says what the task blocks and what it relates to. Each pair is
// listed on both tasks there; it is taken from the side that says
// "outgoing". (A release with no relations answers "not found".)
func (r *orbitReader) relations(ot orbitTask, t *Task) {
	var rels orbitList[struct {
		Type, Direction string
		Task            struct{ ID string }
	}]
	if _, err := getJSON(r.base+"/tasks/"+ot.Identifier+"/relations", r.token, &rels); err != nil {
		return
	}
	for _, rel := range rels.Items {
		switch strings.ToLower(rel.Type) {
		case "blocks":
			if rel.Direction != "incoming" {
				t.Blocks = append(t.Blocks, rel.Task.ID)
			}
		default: // related, duplicate: one row per pair
			if ot.ID < rel.Task.ID {
				t.Relates = append(t.Relates, rel.Task.ID)
			}
		}
	}
}

// comments reads the task's comments, and says where each is in t.Comments
// by its id there.
func (r *orbitReader) comments(ot orbitTask, t *Task) map[string]int {
	var cs orbitList[struct {
		ID, Body  string
		AuthorID  string `json:"author_id"`
		CreatedAt string `json:"created_at"`
	}]
	at := map[string]int{}
	if _, err := getJSON(r.base+"/tasks/"+ot.Identifier+"/comments", r.token, &cs); err != nil {
		return at
	}
	for _, c := range cs.Items {
		at[c.ID] = len(t.Comments)
		t.Comments = append(t.Comments, Comment{Author: orStr(r.called[c.AuthorID], "someone"), At: c.CreatedAt, Body: c.Body})
	}
	return at
}

func (r *orbitReader) docs() error {
	var docs orbitList[struct {
		ID, Title string
		ParentID  string `json:"parent_id"`
	}]
	if _, err := getJSON(r.base+"/docs", r.token, &docs); err != nil {
		return nil // docs need a scope the token may not have
	}
	for _, d := range docs.Items {
		var full struct{ Markdown string }
		if _, err := getJSON(r.base+"/docs/"+d.ID, r.token, &full); err != nil {
			continue
		}
		r.plan.Docs = append(r.plan.Docs, Doc{Ext: d.ID, ParentExt: d.ParentID, Title: d.Title, Markdown: full.Markdown})
	}
	return nil
}
