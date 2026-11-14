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
		return readFolder(source, kind, false)
	case "notion":
		return readNotion(source)
	case "orbit":
		return readOrbit(source, opts["workspace"], opts["token"])
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
// its projects with their tasks and comments, and its docs.
func readOrbit(origin, workspace, token string) (Plan, error) {
	plan := Plan{Source: "orbit"}
	if workspace == "" || token == "" {
		return plan, fmt.Errorf("an Orbit import needs workspace=ID and token=TOKEN (an Orbit API token that can read tasks and docs)")
	}
	base := strings.TrimRight(origin, "/") + "/api/public/v1/workspaces/" + url.PathEscape(workspace)
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
		UserID          string `json:"user_id"`
	}]
	getJSON(base+"/members", token, &members) // names for assignees, when the token may read them
	who := map[string]string{}
	for _, m := range members.Items {
		who[m.ID], who[m.UserID] = orStr(m.Email, m.Name), orStr(m.Email, m.Name)
	}
	keyOf := map[string]string{}
	statusOf := map[string][2]string{} // id -> name, category
	labelOf := map[string]string{}
	orbitCat := map[string]string{"backlog": "backlog", "unstarted": "unstarted", "started": "started", "completed": "done", "cancelled": "canceled", "canceled": "canceled"}
	for _, p := range projects.Items {
		keyOf[p.ID] = p.Key
		plan.Projects = append(plan.Projects, Project{Key: KeyFrom(p.Key), Name: p.Name})
		var sts page[struct{ ID, Name, Category, Type string }]
		if _, err := getJSON(base+"/projects/"+p.ID+"/statuses", token, &sts); err != nil {
			return plan, err
		}
		for _, s := range sts.Items {
			cat := orbitCat[strings.ToLower(orStr(s.Category, s.Type))]
			if cat == "" {
				cat = category(s.Name)
			}
			statusOf[s.ID] = [2]string{s.Name, cat}
		}
		var ls page[struct{ ID, Name string }]
		if _, err := getJSON(base+"/projects/"+p.ID+"/labels", token, &ls); err == nil {
			for _, l := range ls.Items {
				labelOf[l.ID] = l.Name
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
	// Oldest first, so tasks get their numbers in the order they were made.
	for i, j := 0, len(all)-1; i < j; i, j = i+1, j-1 {
		all[i], all[j] = all[j], all[i]
	}
	for _, ot := range all {
		st := statusOf[ot.StatusID]
		t := Task{Ext: ot.ID, Project: KeyFrom(keyOf[ot.ProjectID]), Title: ot.Title, Description: ot.Description, Status: st[0], Category: st[1],
			Priority: priorityNames[ot.Priority], DueOn: ot.DueAt, Estimate: ot.Estimate, ParentExt: ot.ParentTaskID, URL: ot.URL}
		if len(ot.AssigneeIDs) > 0 {
			t.Assignee = orStr(who[ot.AssigneeIDs[0]], ot.AssigneeIDs[0])
		}
		for _, l := range ot.LabelIDs {
			if n := labelOf[l]; n != "" {
				t.Labels = append(t.Labels, n)
			}
		}
		var cs page[struct {
			Body      string
			AuthorID  string `json:"author_id"`
			CreatedAt string `json:"created_at"`
		}]
		if _, err := getJSON(base+"/tasks/"+ot.Identifier+"/comments", token, &cs); err == nil {
			for _, c := range cs.Items {
				t.Comments = append(t.Comments, Comment{Author: orStr(who[c.AuthorID], "someone"), At: c.CreatedAt, Body: c.Body})
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
