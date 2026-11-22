package server_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// samplesAnswer is the answer of POST /samples.
type samplesAnswer struct {
	Project struct {
		ID, Key, Name string
		Samples       []string
	}
}

// liveProjects are the keys of a workspace's projects that are not in the
// trash.
func (s *site) liveProjects(t *testing.T, workspace string) []string {
	t.Helper()
	var out struct {
		Projects []struct{ Key string }
	}
	s.call(t, s.owner, "", "GET", "/api/v1/w/"+workspace+"/list/projects", nil, 200, &out)
	keys := make([]string, len(out.Projects))
	for i, p := range out.Projects {
		keys[i] = p.Key
	}
	return keys
}

// tasksOf are the tasks of a project that are not in the trash: key,
// title and assignee (@handle, or "" for nobody).
func (s *site) tasksOf(t *testing.T, hc *http.Client, project string) [][3]string {
	t.Helper()
	var out struct {
		Tasks []struct{ Key, Title, Assignee string }
	}
	s.call(t, hc, "", "GET", w+"/tasks?sort=key&project="+project, nil, 200, &out)
	got := make([][3]string, len(out.Tasks))
	for i, task := range out.Tasks {
		got[i] = [3]string{task.Key, task.Title, task.Assignee}
	}
	return got
}

// sampleTasks are the sample tasks an install starts with, the first two
// for owner (a handle).
func sampleTasks(owner string) [][3]string {
	return [][3]string{
		{"GS-1", "Open this task and leave a comment", owner},
		{"GS-2", "Write a page in Docs about what you are working on", owner},
		{"GS-3", "Say hello and tell Aram what you can do", ""},
	}
}

// TestSettingAnInstallUpMakesTheSamples: an install set up with the form
// starts with "Getting started" and its three sample tasks, the third for
// nobody yet; a workspace made later starts empty.
func TestSettingAnInstallUpMakesTheSamples(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, nil)
		s.setUp(t)
		if got := s.liveProjects(t, "games"); !slices.Equal(got, []string{"GS"}) {
			t.Fatalf("a new install's projects are %v", got)
		}
		if got := s.tasksOf(t, s.owner, "GS"); !slices.Equal(got, sampleTasks("@aram")) {
			t.Fatalf("a new install's sample tasks are %v", got)
		}

		t.Run("a workspace made later starts empty", func(t *testing.T) {
			s.call(t, s.owner, "", "POST", "/api/v1/workspaces", M{"name": "Later", "slug": "later"}, 201, nil)
			if got := s.liveProjects(t, "later"); len(got) != 0 {
				t.Fatalf("a workspace made after the set-up has the projects %v", got)
			}
		})
	})
}

// TestTheAppsSetUpMakesTheSamples: an install the app sets up starts with
// the same samples.
func TestTheAppsSetUpMakesTheSamples(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		app := theApp(appKey, "")
		s.call(t, app, "", "POST", "/api/v1/auth/setup", M{"name": "Aram Grigoryan", "workspace_name": "Games"}, 201, nil)
		if got := s.tasksOf(t, s.signedInAs(t, app), "GS"); !slices.Equal(got, sampleTasks("@aram-grigoryan")) {
			t.Fatalf("the app's install's sample tasks are %v", got)
		}
	})
}

// TestTheSamplesAreAskedForAndRemoved: asking for the samples while they
// are there changes nothing but hands the third to an agent once; only an
// owner or admin may ask or remove them, and removing them leaves the
// person's own work where it is.
func TestTheSamplesAreAskedForAndRemoved(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, nil)
		s.setUp(t)
		coder := s.change(t, s.owner, "", "agent.create", M{"name": "Claude Code", "handle": "claude-code"})["ref"].(string)
		s.change(t, s.owner, "", "agent.create", M{"name": "Codex", "handle": "codex"})
		// The set-up made them: asking answers with them.
		var made samplesAnswer
		s.call(t, s.owner, "", "POST", w+"/samples", M{}, 200, &made)
		if made.Project.Key != "GS" || made.Project.Name != "Getting started" || len(made.Project.Samples) != 3 {
			t.Fatalf("the samples' project is %+v", made.Project)
		}

		t.Run("an agent named takes the third, once", func(t *testing.T) {
			var again samplesAnswer
			s.call(t, s.owner, "", "POST", w+"/samples", M{"agent": coder}, 200, &again)
			s.call(t, s.owner, "", "POST", w+"/samples", M{"agent": "@codex"}, 200, nil)
			if again.Project.ID != made.Project.ID || s.tasksOf(t, s.owner, "GS")[2][2] != "@claude-code" || len(s.tasksOf(t, s.owner, "GS")) != 3 {
				t.Fatalf("after naming agents the samples are %v", s.tasksOf(t, s.owner, "GS"))
			}
		})

		t.Run("the agent must be one", func(t *testing.T) {
			s.call(t, s.owner, "", "POST", w+"/samples", M{"agent": s.ownerID(t)}, 400, nil)
			s.call(t, s.owner, "", "POST", w+"/samples", M{"agent": "@nobody"}, 400, nil)
		})

		t.Run("a credential kept to other projects learns nothing of them", func(t *testing.T) {
			s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			var narrow struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "narrow", "projects": []string{"SVA"}}, 201, &narrow)
			for _, method := range []string{"POST", "DELETE"} {
				if out := s.call(t, nil, narrow.Token, method, w+"/samples", M{}, 403, nil); strings.Contains(out, made.Project.ID) {
					t.Fatalf("%s /samples told a credential kept to SVA of the samples' project: %s", method, out)
				}
			}
		})

		t.Run("an agent may not", func(t *testing.T) {
			s.change(t, s.owner, "", "member.update", M{"id": "@codex", "role": "admin"})
			var bot struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "bot", "user": "@codex"}, 201, &bot)
			s.call(t, nil, bot.Token, "POST", w+"/samples", M{}, 403, nil)
			s.call(t, nil, bot.Token, "DELETE", w+"/samples", nil, 403, nil)
		})

		t.Run("a member may not", func(t *testing.T) {
			bea, _ := s.invitedPerson(t)
			s.call(t, bea, "", "POST", w+"/samples", M{}, 403, nil)
			s.call(t, bea, "", "DELETE", w+"/samples", nil, 403, nil)
		})

		t.Run("removed, and asked for again", func(t *testing.T) {
			s.call(t, s.owner, "", "DELETE", w+"/samples", nil, 204, nil)
			if got := s.liveProjects(t, "games"); !slices.Equal(got, []string{"SVA"}) {
				t.Fatalf("after removing the samples the projects are %v", got)
			}
			s.call(t, s.owner, "", "DELETE", w+"/samples", nil, 204, nil)
			var anew samplesAnswer
			s.call(t, s.owner, "", "POST", w+"/samples", M{}, 201, &anew)
			if anew.Project.Key != "GS2" || anew.Project.ID == made.Project.ID {
				t.Fatalf("asked for after a removal, the samples are %+v", anew.Project)
			}
		})

		t.Run("the person's own work stays", func(t *testing.T) {
			s.change(t, s.owner, "", "task.create", M{"project": "GS2", "title": "Plan the launch"})
			s.call(t, s.owner, "", "DELETE", w+"/samples", nil, 204, nil)
			if got := s.tasksOf(t, s.owner, "GS2"); len(got) != 1 || got[0][1] != "Plan the launch" {
				t.Fatalf("after removing the samples beside a task of the person's own, the project holds %v", got)
			}
		})
	})
}
