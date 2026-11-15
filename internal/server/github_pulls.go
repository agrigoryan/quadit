package server

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// Pull requests and their checks, onto the tasks they name.

// ghPull is a pull request as GitHub's API gives it.
type ghPull struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	State     string `json:"state"`
	Draft     bool   `json:"draft"`
	HTMLURL   string `json:"html_url"`
	UpdatedAt string `json:"updated_at"`
	MergedAt  string `json:"merged_at"`
	Head      struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
	User struct {
		Login string `json:"login"`
	} `json:"user"`
}

// ghKeyRE finds task keys (SVA-12) in text.
var ghKeyRE = regexp.MustCompile(`(?i)\b([A-Z][A-Z0-9]{1,9})-(\d+)\b`)

// syncPulls goes through the pull requests that changed since the last
// pass, or whose checks had not finished then, and brings the link on each
// task they name up to date.
func (g *githubSync) syncPulls(ctx context.Context) (int, error) {
	var pulls []ghPull
	if err := g.gh.call(ctx, "GET", "/repos/"+g.cfg.Repo+"/pulls?state=all&sort=updated&direction=desc&per_page=50", nil, &pulls); err != nil {
		return 0, err
	}
	isKey, err := g.projectKeys(ctx)
	if err != nil {
		return 0, err
	}
	newest := g.state.Since
	handled := 0
	for _, pr := range pulls {
		num := fmt.Sprint(pr.Number)
		changed := pr.UpdatedAt > g.state.Since
		if !changed && !g.state.PendingChecks[num] {
			continue
		}
		if pr.UpdatedAt > newest {
			newest = pr.UpdatedAt
		}
		keys := pr.taskKeys(isKey)
		if len(keys) == 0 {
			continue
		}
		state := pr.state()
		checks := g.checksOf(ctx, pr, state)
		g.state.Heads[num] = pr.Head.SHA
		for key := range keys {
			if err := g.linkPull(ctx, pr, key, state, checks); err != nil {
				return handled, err
			}
		}
		handled++
	}
	g.state.Since = newest
	return handled, nil
}

// projectKeys says which keys are real: the workspace's project keys, or
// the key of the integration's own project when it has one.
func (g *githubSync) projectKeys(ctx context.Context) (map[string]bool, error) {
	var projects []core.Project
	if err := g.db.List(ctx, &projects, store.Where(store.Live)); err != nil {
		return nil, err
	}
	isKey := map[string]bool{}
	for _, p := range projects {
		if g.in.ProjectID == "" || g.in.ProjectID == p.ID {
			isKey[p.Key] = true
		}
	}
	return isKey, nil
}

// taskKeys finds the task keys (SVA-12) named in the pull request's title,
// branch or description, among the projects whose keys are given.
func (pr ghPull) taskKeys(isKey map[string]bool) map[string]bool {
	keys := map[string]bool{}
	for _, m := range ghKeyRE.FindAllStringSubmatch(pr.Title+"\n"+pr.Head.Ref+"\n"+pr.Body, -1) {
		if isKey[strings.ToUpper(m[1])] {
			keys[strings.ToUpper(m[1])+"-"+m[2]] = true
		}
	}
	return keys
}

// state is where the pull request stands: open, draft, merged or closed.
func (pr ghPull) state() string {
	switch {
	case pr.MergedAt != "":
		return "merged"
	case pr.Draft && pr.State == "open":
		return "draft"
	}
	return pr.State
}

// checksOf reads how the checks of the pull request's head commit stand:
// passing, failing, pending, or nothing when there are none or they could
// not be read. Only a pull request that is still open is asked about; one
// whose checks are pending is remembered, to be looked at again next time.
func (g *githubSync) checksOf(ctx context.Context, pr ghPull, state string) string {
	num := fmt.Sprint(pr.Number)
	if state != "open" && state != "draft" {
		delete(g.state.PendingChecks, num)
		return ""
	}
	checks := ""
	var runs struct {
		CheckRuns []struct {
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
		} `json:"check_runs"`
	}
	if err := g.gh.call(ctx, "GET", "/repos/"+g.cfg.Repo+"/commits/"+pr.Head.SHA+"/check-runs?per_page=100", nil, &runs); err == nil && len(runs.CheckRuns) > 0 {
		checks = "passing"
		for _, r := range runs.CheckRuns {
			switch {
			case r.Status != "completed":
				if checks != "failing" {
					checks = "pending"
				}
			case r.Conclusion == "failure" || r.Conclusion == "timed_out" || r.Conclusion == "cancelled" || r.Conclusion == "action_required": //nolint:misspell // GitHub's own spelling of the conclusion
				checks = "failing"
			}
		}
	}
	g.state.PendingChecks[num] = checks == "pending"
	return checks
}

// linkPull puts the pull request on the task with this key, as a link that
// says how it and its checks stand. A key with no task is passed over.
func (g *githubSync) linkPull(ctx context.Context, pr ghPull, key, state, checks string) error {
	var t core.Task
	if there, err := store.Find(ctx, g.db, &t, store.Eq("key", key), store.Live); err != nil || !there {
		return err
	}
	num := fmt.Sprint(pr.Number)
	data := plainjson.Marshal(map[string]any{"branch": pr.Head.Ref, "author": pr.User.Login, "sha": pr.Head.SHA})
	err := g.s.eng.System(ctx, g.in.WorkspaceID, g.in.CreatedBy, func(sys *engine.Sys) error {
		if err := sys.Do("link.set", map[string]any{"task": t.ID, "kind": "pr", "repo": g.cfg.Repo, "ref": num, "url": pr.HTMLURL, "title": pr.Title,
			"state": state, "checks": checks, "data": json.RawMessage(data)}); err != nil {
			return err
		}
		// Move the task along with its pull request, when asked to.
		to := ""
		switch {
		case state == "merged" && g.cfg.OnMerge != "":
			to = g.cfg.OnMerge
		case (state == "open" || state == "draft") && g.cfg.OnOpen != "":
			var cur core.Status
			there, err := store.Find(ctx, sys.Tx(), &cur, store.Eq("id", t.StatusID))
			if err != nil {
				return err
			}
			if there && (cur.Category == core.CatBacklog || cur.Category == core.CatUnstarted) {
				to = g.cfg.OnOpen
			}
		}
		if to == "" {
			return nil
		}
		return sys.Do("task.update", map[string]any{"id": t.ID, "status": to})
	})
	if err != nil {
		return fmt.Errorf("%s: %w", key, err)
	}
	return g.commentBack(ctx, pr, key, t)
}

// commentBack posts a link to the task on the pull request, once, when the
// integration is set to and has a token to write with. When the workspace
// cannot be read there is no link to give: that is an error, and the pass
// is done again. A comment GitHub does not take is tried again on the next
// pass that looks at the pull request.
func (g *githubSync) commentBack(ctx context.Context, pr ghPull, key string, t core.Task) error {
	mark := fmt.Sprint(pr.Number) + " " + key
	if !g.cfg.CommentBack || g.state.Commented[mark] || g.token == "" {
		return nil
	}
	var ws core.Workspace
	if err := g.s.st.Get(ctx, &ws, store.Eq("id", g.in.WorkspaceID)); err != nil {
		return fmt.Errorf("%s: commenting on #%d: %w", key, pr.Number, err)
	}
	body := fmt.Sprintf("Linked to **%s** %s — %s/%s/task/%s", key, t.Title, g.s.cfg.BaseURL, ws.Slug, key)
	if err := g.gh.call(ctx, "POST", fmt.Sprintf("/repos/%s/issues/%d/comments", g.cfg.Repo, pr.Number), map[string]string{"body": body}, nil); err == nil {
		g.state.Commented[mark] = true
	}
	return nil
}
