package importer

import (
	"archive/zip"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Kinds lists what can be imported.
var Kinds = []string{"linear", "trello", "asana", "github", "markdown", "obsidian", "notion", "orbit"}

// Read turns a source into a plan. opts carries what a source needs beyond
// its path: a token, a workspace.
func Read(kind, source string, opts map[string]string) (Plan, error) {
	switch kind {
	case "linear":
		return readCSV(source, "linear", linearRow)
	case "asana":
		return readCSV(source, "asana", asanaRow)
	case "trello":
		return readTrello(source)
	case "github":
		return readGitHub(source, opts["token"], opts["api"])
	case "markdown", "obsidian":
		// A folder, or the folder as a zip (how it arrives through the web app).
		if info, err := os.Stat(source); err == nil && !info.IsDir() && strings.HasSuffix(strings.ToLower(source), ".zip") {
			dir, err := os.MkdirTemp("", "quadit-"+kind+"-*")
			if err != nil {
				return Plan{}, err
			}
			if err := unzip(source, dir); err != nil {
				return Plan{}, err
			}
			// A zip of one folder holds that folder: read inside it.
			if entries, err := os.ReadDir(dir); err == nil && len(entries) == 1 && entries[0].IsDir() {
				dir = filepath.Join(dir, entries[0].Name())
			}
			return readFolder(dir, kind, false)
		}
		return readFolder(source, kind, false)
	case "notion":
		return readNotion(source)
	case "orbit":
		return readOrbit(source, opts["workspace"], opts["token"], opts["session"])
	}
	return Plan{}, fmt.Errorf("unknown source %q; sources are: %s", kind, strings.Join(Kinds, ", "))
}

// category guesses a status category from a status's name.
func category(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "cancel") || strings.Contains(n, "duplicate") || strings.Contains(n, "won't") || strings.Contains(n, "wont"):
		return "canceled"
	case strings.Contains(n, "done") || strings.Contains(n, "complete") || strings.Contains(n, "closed") || strings.Contains(n, "shipped") || strings.Contains(n, "merged"):
		return "done"
	case strings.Contains(n, "wait") || strings.Contains(n, "blocked") || strings.Contains(n, "hold"):
		return "waiting"
	case strings.Contains(n, "progress") || strings.Contains(n, "doing") || strings.Contains(n, "review") || strings.Contains(n, "started"):
		return "started"
	case strings.Contains(n, "backlog") || strings.Contains(n, "icebox") || strings.Contains(n, "triage") || strings.Contains(n, "someday"):
		return "backlog"
	}
	return "unstarted"
}

func readCSV(path, source string, row func(get func(...string) string) Task) (Plan, error) {
	plan := Plan{Source: source}
	f, err := os.Open(path)
	if err != nil {
		return plan, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.FieldsPerRecord, r.LazyQuotes = -1, true
	head, err := r.Read()
	if err != nil {
		return plan, fmt.Errorf("%s: %w", path, err)
	}
	col := map[string]int{}
	for i, h := range head {
		col[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))] = i
	}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return plan, fmt.Errorf("%s: %w", path, err)
		}
		// get returns the first of the named columns that has a value.
		get := func(names ...string) string {
			for _, n := range names {
				if i, ok := col[n]; ok && i < len(rec) && strings.TrimSpace(rec[i]) != "" {
					return strings.TrimSpace(rec[i])
				}
			}
			return ""
		}
		if t := row(get); t.Title != "" {
			plan.Tasks = append(plan.Tasks, t)
		}
	}
	return plan, nil
}

var priorityNames = map[string]int{"urgent": 1, "high": 2, "medium": 3, "normal": 3, "low": 4}

func linearRow(get func(...string) string) Task {
	t := Task{Ext: get("id"), Title: get("title"), Description: get("description"), Status: get("status"), Assignee: get("assignee"),
		DueOn: get("due date"), Epic: get("project"), ParentExt: get("parent issue"), Priority: priorityNames[strings.ToLower(get("priority"))]}
	t.Category = category(t.Status)
	switch {
	case get("canceled") != "":
		t.Category = "canceled"
	case get("completed") != "":
		t.Category = "done"
	case get("started") != "" && t.Category == "unstarted":
		t.Category = "started"
	}
	t.Estimate, _ = strconv.Atoi(strings.SplitN(get("estimate"), ".", 2)[0])
	if l := get("labels"); l != "" {
		t.Labels = strings.Split(l, ",")
	}
	return t
}

func asanaRow(get func(...string) string) Task {
	t := Task{Ext: get("task id"), Title: get("name"), Description: get("notes"), Status: get("section/column", "section"), Assignee: get("assignee email", "assignee"),
		DueOn: get("due date"), Epic: get("projects"), ParentExt: get("parent task id")}
	t.Category = category(t.Status)
	if get("completed at") != "" {
		t.Category = "done"
		if t.Status == "" || category(t.Status) != "done" {
			t.Status = "" // done there, whatever column it sat in
		}
	}
	if l := get("tags"); l != "" {
		t.Labels = strings.Split(l, ",")
	}
	return t
}

func readTrello(path string) (Plan, error) {
	plan := Plan{Source: "trello"}
	raw, err := os.ReadFile(path)
	if err != nil {
		return plan, err
	}
	var board struct {
		Lists []struct{ ID, Name string }
		Cards []struct {
			ID, Name, Desc, IDList, Due, ShortURL string
			Closed                                bool
			Labels                                []struct{ Name, Color string }
			IDChecklists                          []string
		}
		Checklists []struct {
			ID, Name   string
			CheckItems []struct{ Name, State string }
		}
		Actions []struct {
			Type, Date    string
			MemberCreator struct{ FullName string }
			Data          struct {
				Text string
				Card struct{ ID string }
			}
		}
	}
	if err := json.Unmarshal(raw, &board); err != nil {
		return plan, fmt.Errorf("%s is not a Trello board export: %w", path, err)
	}
	listName := map[string]string{}
	for _, l := range board.Lists {
		listName[l.ID] = l.Name
	}
	checks := map[string]string{}
	for _, cl := range board.Checklists {
		var b strings.Builder
		fmt.Fprintf(&b, "\n\n**%s**\n\n", cl.Name)
		for _, it := range cl.CheckItems {
			mark := " "
			if it.State == "complete" {
				mark = "x"
			}
			fmt.Fprintf(&b, "- [%s] %s\n", mark, it.Name)
		}
		checks[cl.ID] = b.String()
	}
	comments := map[string][]Comment{}
	for i := len(board.Actions) - 1; i >= 0; i-- { // the export lists newest first
		a := board.Actions[i]
		if a.Type == "commentCard" {
			comments[a.Data.Card.ID] = append(comments[a.Data.Card.ID], Comment{Author: a.MemberCreator.FullName, At: a.Date, Body: a.Data.Text})
		}
	}
	for _, c := range board.Cards {
		t := Task{Ext: c.ID, Title: c.Name, Description: c.Desc, Status: listName[c.IDList], DueOn: c.Due, URL: c.ShortURL, Comments: comments[c.ID]}
		t.Category = category(t.Status)
		for _, id := range c.IDChecklists {
			t.Description += checks[id]
		}
		for _, l := range c.Labels {
			t.Labels = append(t.Labels, orStr(l.Name, l.Color))
		}
		if c.Closed && t.Category != "done" {
			t.Status, t.Category = "", "canceled" // archived there
		}
		plan.Tasks = append(plan.Tasks, t)
	}
	return plan, nil
}

func getJSON(u, token string, dst any) (http.Header, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "quadit-import")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	hc := http.Client{Timeout: 60 * time.Second}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s answered %s: %.200s", u, resp.Status, body)
	}
	return resp.Header, json.Unmarshal(body, dst)
}

// getFile fetches a file to path, making its folder.
func getFile(u, token, path string) error {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "quadit-import")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	hc := http.Client{Timeout: 10 * time.Minute}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s answered %s", u, resp.Status)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(path)
		return err
	}
	return out.Close()
}

// readGitHub reads a repository's issues (not its pull requests) with
// their comments.
func readGitHub(repo, token, api string) (Plan, error) {
	plan := Plan{Source: "github"}
	api = strings.TrimRight(orStr(api, "https://api.github.com"), "/")
	for page := 1; page < 200; page++ {
		var issues []struct {
			Number      int
			Title, Body string
			State       string
			HTMLURL     string `json:"html_url"`
			Comments    int
			PullRequest *struct{} `json:"pull_request"`
			Labels      []struct{ Name string }
			Assignee    *struct{ Login string }
			User        struct{ Login string }
			Milestone   *struct{ Title string }
			StateReason string `json:"state_reason"`
		}
		if _, err := getJSON(fmt.Sprintf("%s/repos/%s/issues?state=all&per_page=100&direction=asc&page=%d", api, repo, page), token, &issues); err != nil {
			return plan, err
		}
		for _, is := range issues {
			if is.PullRequest != nil {
				continue
			}
			t := Task{Ext: repo + "#" + strconv.Itoa(is.Number), Title: is.Title, Description: is.Body, URL: is.HTMLURL, Category: "unstarted"}
			if is.State == "closed" {
				t.Category = "done"
				if is.StateReason == "not_planned" {
					t.Category = "canceled"
				}
			}
			for _, l := range is.Labels {
				t.Labels = append(t.Labels, l.Name)
			}
			if is.Assignee != nil {
				t.Assignee = is.Assignee.Login
			}
			if is.Milestone != nil {
				t.Epic = is.Milestone.Title
			}
			if is.Comments > 0 {
				var cs []struct {
					Body      string
					CreatedAt string `json:"created_at"`
					User      struct{ Login string }
				}
				if _, err := getJSON(fmt.Sprintf("%s/repos/%s/issues/%d/comments?per_page=100", api, repo, is.Number), token, &cs); err != nil {
					return plan, err
				}
				for _, c := range cs {
					t.Comments = append(t.Comments, Comment{Author: c.User.Login, At: c.CreatedAt, Body: c.Body})
				}
			}
			plan.Tasks = append(plan.Tasks, t)
		}
		if len(issues) < 100 {
			break
		}
	}
	return plan, nil
}

var notionID = regexp.MustCompile(`\s+[0-9a-f]{32}$`)

// readFolder reads a folder of Markdown files as a tree of pages: a
// directory becomes a page that holds the files in it. With notion set,
// the ids Notion adds to every name are dropped and CSV files become
// databases.
func readFolder(root, source string, notion bool) (Plan, error) {
	plan := Plan{Source: source}
	clean := func(name string) string {
		name = strings.TrimSuffix(name, filepath.Ext(name))
		if notion {
			name = notionID.ReplaceAllString(name, "")
		}
		return name
	}
	info, err := os.Stat(root)
	if err != nil {
		return plan, err
	}
	if !info.IsDir() {
		return plan, fmt.Errorf("%s is not a folder", root)
	}
	dirDoc := map[string]bool{}
	var paths []string
	err = filepath.WalkDir(root, func(p string, e os.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if e.IsDir() && p != root && (strings.HasPrefix(e.Name(), ".") || e.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if !e.IsDir() {
			paths = append(paths, p)
		}
		return nil
	})
	if err != nil {
		return plan, err
	}
	sort.Strings(paths)
	// parent returns the page a file's directory stands for, making a page
	// for each directory on the way unless a file of the same name is it.
	var parent func(dir string) string
	parent = func(dir string) string {
		rel, _ := filepath.Rel(root, dir)
		if rel == "." {
			return ""
		}
		ext := filepath.ToSlash(rel)
		if !dirDoc[ext] {
			dirDoc[ext] = true
			// Notion exports "Page.md" beside a folder "Page" of its children.
			if _, err := os.Stat(dir + ".md"); err != nil {
				plan.Docs = append(plan.Docs, Doc{Ext: ext, ParentExt: parent(filepath.Dir(dir)), Title: clean(filepath.Base(dir))})
			}
		}
		return ext
	}
	for _, p := range paths {
		rel, _ := filepath.Rel(root, p)
		ext := filepath.ToSlash(strings.TrimSuffix(rel, filepath.Ext(rel)))
		switch strings.ToLower(filepath.Ext(p)) {
		case ".md", ".markdown":
			raw, err := os.ReadFile(p)
			if err != nil {
				return plan, err
			}
			body := string(raw)
			title := clean(filepath.Base(p))
			if notion { // Notion repeats the title as the first heading
				if first, rest, ok := strings.Cut(body, "\n"); ok && strings.TrimSpace(strings.TrimPrefix(first, "# ")) == title {
					body = strings.TrimLeft(rest, "\n")
				}
			}
			plan.Docs = append(plan.Docs, Doc{Ext: ext, ParentExt: parent(filepath.Dir(p)), Title: title, Markdown: body, Dir: filepath.Dir(p)})
		case ".csv":
			if !notion || strings.HasSuffix(strings.TrimSuffix(p, ".csv"), "_all") {
				continue
			}
			f, err := os.Open(p)
			if err != nil {
				return plan, err
			}
			r := csv.NewReader(f)
			r.FieldsPerRecord, r.LazyQuotes = -1, true
			recs, err := r.ReadAll()
			f.Close()
			if err != nil || len(recs) == 0 {
				continue
			}
			recs[0][0] = strings.TrimPrefix(recs[0][0], "\ufeff")
			plan.Tables = append(plan.Tables, Table{Ext: ext, ParentExt: parent(filepath.Dir(p)), Title: clean(filepath.Base(p)), Columns: recs[0], Rows: recs[1:]})
		}
	}
	// Parents before children, so a page's place exists when it is made.
	sort.SliceStable(plan.Docs, func(i, j int) bool {
		return strings.Count(plan.Docs[i].Ext, "/") < strings.Count(plan.Docs[j].Ext, "/")
	})
	return plan, nil
}

// readNotion reads a Notion export: the zip it gives, or that zip unpacked.
func readNotion(source string) (Plan, error) {
	info, err := os.Stat(source)
	if err != nil {
		return Plan{}, err
	}
	if info.IsDir() {
		return readFolder(source, "notion", true)
	}
	dir, err := os.MkdirTemp("", "quadit-notion-*")
	if err != nil {
		return Plan{}, err
	}
	// The folder stays until the import has uploaded its images; the
	// system clears temporary folders in time.
	if err := unzip(source, dir); err != nil {
		return Plan{}, err
	}
	return readFolder(dir, "notion", true)
}

func unzip(src, dst string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return fmt.Errorf("%s is not a zip file: %w", src, err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		p := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			return fmt.Errorf("the zip holds a path that climbs out of it: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o750)
			continue
		}
		os.MkdirAll(filepath.Dir(p), 0o750)
		in, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(p)
		if err == nil {
			_, err = io.Copy(out, io.LimitReader(in, 2<<30))
			out.Close()
		}
		in.Close()
		if err != nil {
			return err
		}
		// A Notion export nests one zip inside another.
		if strings.HasSuffix(strings.ToLower(p), ".zip") {
			if err := unzip(p, strings.TrimSuffix(p, filepath.Ext(p))); err != nil {
				return err
			}
			os.Remove(p)
		}
	}
	return nil
}

// readOrbit reads a workspace from an Orbit server through its public API:
// its projects with their statuses and labels, their tasks and comments,
// and its docs. Orbit hands attached files only to a signed-in session, not
// to an API token: with session they are fetched too.
func readOrbit(origin, workspace, token, session string) (Plan, error) {
	plan := Plan{Source: "orbit"}
	if workspace == "" || token == "" {
		return plan, fmt.Errorf("an Orbit import needs workspace=ID and token=TOKEN (an Orbit API token that can read tasks and docs)")
	}
	if session == "" {
		plan.Notes = []string{"Orbit hands attached files only to a signed-in session, not to an API token, so they are not brought over: " +
			"pictures in descriptions and comments will point at Orbit. Give session=TOKEN to bring the files too " +
			"(Orbit answers a sign-in sent without an Origin header, POST /api/v1/auth/login, with one)."}
	}
	origin = strings.TrimRight(origin, "/")
	base := origin + "/api/public/v1/workspaces/" + url.PathEscape(workspace)
	type page[T any] struct {
		Items []T    `json:"items"`
		Next  string `json:"next_cursor"`
	}
	var projects page[struct{ ID, Name, Key string }]
	if _, err := getJSON(base+"/projects", token, &projects); err != nil {
		return plan, err
	}
	var members page[struct {
		ID, Name, Email string
		DisplayName     string `json:"display_name"`
		UserID          string `json:"user_id"`
	}]
	getJSON(base+"/members", token, &members) // names for assignees, when the token may read them
	// who is matched to a member here (an email address when Orbit gives
	// one), called is what a person reads.
	who, called := map[string]string{}, map[string]string{}
	for _, m := range members.Items {
		name := orStr(m.DisplayName, m.Name)
		for _, k := range []string{m.ID, m.UserID} {
			if k != "" {
				who[k], called[k] = orStr(m.Email, name), orStr(name, m.Email)
			}
		}
	}
	keyOf := map[string]string{}
	statusOf := map[string][2]string{} // id -> name, category
	labelOf := map[string]string{}
	milestoneOf := map[string]string{}
	orbitCat := map[string]string{"backlog": "backlog", "unstarted": "unstarted", "started": "started", "completed": "done",
		"cancelled": "canceled", "canceled": "canceled", "duplicate": "canceled"}
	for _, p := range projects.Items {
		keyOf[p.ID] = p.Key
		plan.Projects = append(plan.Projects, Project{Key: KeyFrom(p.Key), Name: p.Name})
		var sts page[struct {
			ID, Name, Category, Type, Color string
			Position                        int
		}]
		if _, err := getJSON(base+"/projects/"+p.ID+"/statuses", token, &sts); err != nil {
			return plan, err
		}
		sort.SliceStable(sts.Items, func(i, j int) bool { return sts.Items[i].Position < sts.Items[j].Position })
		for _, s := range sts.Items {
			cat := orbitCat[strings.ToLower(orStr(s.Category, s.Type))]
			// Orbit has fewer kinds of status: its "Backlog" is a status not
			// started, its "Waiting on you" one that is. The name says which
			// of ours it is.
			switch guess := category(s.Name); {
			case cat == "", cat == "unstarted" && guess == "backlog", cat == "started" && guess == "waiting":
				cat = guess
			}
			statusOf[s.ID] = [2]string{s.Name, cat}
			plan.Statuses = append(plan.Statuses, Status{Project: KeyFrom(p.Key), Name: s.Name, Category: cat, Color: s.Color})
		}
		var ls page[struct{ ID, Name, Color string }]
		if _, err := getJSON(base+"/projects/"+p.ID+"/labels", token, &ls); err == nil {
			for _, l := range ls.Items {
				labelOf[l.ID] = l.Name
				plan.Labels = append(plan.Labels, Label{Project: KeyFrom(p.Key), Name: l.Name, Color: l.Color})
			}
		}
		// Orbit's milestones are stages of a project; here they become epics.
		var ms page[struct{ ID, Name string }]
		if _, err := getJSON(base+"/projects/"+p.ID+"/milestones", token, &ms); err == nil {
			for _, m := range ms.Items {
				milestoneOf[m.ID] = m.Name
			}
		}
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
	var all []orbitTask
	for cursor := ""; ; {
		var pg page[orbitTask]
		u := base + "/tasks?limit=100"
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}
		if _, err := getJSON(u, token, &pg); err != nil {
			return plan, err
		}
		all = append(all, pg.Items...)
		if pg.Next == "" || len(pg.Items) == 0 {
			break
		}
		cursor = pg.Next
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
		st := statusOf[ot.StatusID]
		t := Task{Ext: ot.ID, Project: KeyFrom(keyOf[ot.ProjectID]), Title: ot.Title, Description: ot.Description, Status: st[0], Category: st[1],
			Priority: priorityNames[ot.Priority], DueOn: ot.DueAt, Estimate: ot.Estimate, ParentExt: ot.ParentTaskID, URL: ot.URL,
			Epic: milestoneOf[ot.MilestoneID], WasKey: ot.Identifier, Number: ot.Number}
		// What it blocks and what it relates to. Each pair is listed on both
		// tasks there; it is taken from the side that says "outgoing".
		var rels page[struct {
			Type, Direction string
			Task            struct{ ID string }
		}]
		if _, err := getJSON(base+"/tasks/"+ot.Identifier+"/relations", token, &rels); err == nil {
			for _, r := range rels.Items {
				switch strings.ToLower(r.Type) {
				case "blocks":
					if r.Direction != "incoming" {
						t.Blocks = append(t.Blocks, r.Task.ID)
					}
				default: // related, duplicate: one row per pair
					if ot.ID < r.Task.ID {
						t.Relates = append(t.Relates, r.Task.ID)
					}
				}
			}
		}
		if len(ot.AssigneeIDs) > 0 {
			t.Assignee = orStr(who[ot.AssigneeIDs[0]], ot.AssigneeIDs[0])
		}
		for _, l := range ot.LabelIDs {
			if n := labelOf[l]; n != "" {
				t.Labels = append(t.Labels, n)
			}
		}
		var cs page[struct {
			ID, Body  string
			AuthorID  string `json:"author_id"`
			CreatedAt string `json:"created_at"`
		}]
		commentAt := map[string]int{}
		if _, err := getJSON(base+"/tasks/"+ot.Identifier+"/comments", token, &cs); err == nil {
			for _, c := range cs.Items {
				commentAt[c.ID] = len(t.Comments)
				t.Comments = append(t.Comments, Comment{Author: orStr(called[c.AuthorID], "someone"), At: c.CreatedAt, Body: c.Body})
			}
		}
		if session != "" {
			// The files, from the routes Orbit's own web app uses.
			inner := "/api/v1/workspaces/" + url.PathEscape(workspace) + "/tasks/" + url.PathEscape(ot.ID) + "/attachments"
			var raw json.RawMessage
			if _, err := getJSON(origin+inner, session, &raw); err != nil {
				return plan, fmt.Errorf("the files of %s: %w (session must be a signed-in Orbit session, not an API token)", ot.Identifier, err)
			}
			type attached struct {
				ID        string
				Name      string `json:"display_name"`
				CommentID string `json:"comment_id"`
				Deleted   bool
			}
			var list []attached
			var wrapped page[attached]
			if json.Unmarshal(raw, &wrapped) == nil && wrapped.Items != nil {
				list = wrapped.Items
			} else {
				json.Unmarshal(raw, &list)
			}
			for _, a := range list {
				if a.Deleted || a.ID == "" {
					continue
				}
				if plan.Tmp == "" {
					dir, err := os.MkdirTemp("", "quadit-orbit-*")
					if err != nil {
						return plan, err
					}
					plan.Tmp = dir
				}
				name := filepath.Base(strings.ReplaceAll(a.Name, "\\", "/"))
				if name == "" || name == "." || name == "/" {
					name = "file"
				}
				path := filepath.Join(plan.Tmp, a.ID, name)
				link := inner + "/" + a.ID + "/download"
				if err := getFile(origin+link, session, path); err != nil {
					plan.Notes = append(plan.Notes, fmt.Sprintf("the file %s of %s could not be fetched: %v", a.Name, ot.Identifier, err))
					continue
				}
				plan.Files = append(plan.Files, File{Ext: a.ID, Path: path, Links: []string{origin + link, link}})
				if i, ok := commentAt[a.CommentID]; ok && a.CommentID != "" {
					t.Comments[i].Files = append(t.Comments[i].Files, a.ID)
				} else {
					t.Files = append(t.Files, a.ID)
				}
			}
		}
		plan.Tasks = append(plan.Tasks, t)
	}
	var docs page[struct {
		ID, Title string
		ParentID  string `json:"parent_id"`
	}]
	if _, err := getJSON(base+"/docs", token, &docs); err == nil { // docs need a scope the token may not have
		for _, d := range docs.Items {
			var full struct{ Markdown string }
			if _, err := getJSON(base+"/docs/"+d.ID, token, &full); err != nil {
				continue
			}
			plan.Docs = append(plan.Docs, Doc{Ext: d.ID, ParentExt: d.ParentID, Title: d.Title, Markdown: full.Markdown})
		}
	}
	return plan, nil
}
