// samples.add and samples.remove: the sample tasks a new install starts
// with, to try Quadit on, and taking them away again.
//
// The samples are a project "Getting started" with three tasks marked by a
// label "Sample". The label is for the person; what makes a task a sample
// is that its project lists it (core.Project.Samples), so the samples are
// found again exactly, whatever is done to them or around them.

package engine

import (
	"errors"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("samples.add", core.RoleAdmin, samplesAdd)
	register("samples.remove", core.RoleAdmin, samplesRemove)
}

// What the samples are called and marked with.
const (
	samplesKey     = "GS"
	samplesProject = "Getting started"
	sampleLabel    = "Sample"
	sampleColor    = "#9a6bff"
)

type samplesAddArgs struct {
	// Agent is the agent the third sample is for, by id or @handle; empty
	// leaves it for nobody.
	Agent string `json:"agent"`
}

// samplesAdd makes the samples, unless they are there: then the answer is
// their project, after the third sample is given to the agent named when it
// is still there and has nobody. Either way the change's answer (ref, key)
// is the project.
func samplesAdd(c *cx, a samplesAddArgs) error {
	agentID, err := c.sampleAgent(a.Agent)
	if err != nil {
		return err
	}
	project, there, err := c.samplesThere()
	if err != nil {
		return err
	}
	if !there {
		return c.makeSamples(agentID)
	}
	if agentID != "" && len(project.Samples) == 3 {
		var third core.Task
		found, err := store.Find(c.ctx, c.tx, &third, store.Eq("id", project.Samples[2]), store.Live)
		if err != nil {
			return err
		}
		if found && third.AssigneeID == "" {
			if err := c.applyNested("task.update", map[string]any{"id": third.ID, "assignee": agentID}); err != nil {
				return err
			}
		}
	}
	c.ref, c.key = project.ID, project.Key
	return nil
}

// sampleAgent is the user id of the agent named for the third sample, or ""
// when none is.
func (c *cx) sampleAgent(ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	m, err := c.memberRef("agent", ref)
	// A name that finds nobody is a wrong argument here, not a missing
	// thing: the samples are asked for, not the agent.
	if refusal, ok := errors.AsType[*Error](err); ok && refusal.Code == CodeNotFound {
		refusal.Code = CodeInvalid
		return "", refusal
	}
	if err != nil {
		return "", err
	}
	if m.Kind != core.KindAgent {
		return "", invalid("agent", "@%s is a person; the third sample task is for an agent", m.Handle)
	}
	return m.UserID, nil
}

// makeSamples makes the samples' project, its label and the three tasks:
// the first two for the one who asks, the third for agentID or nobody.
func (c *cx) makeSamples(agentID string) error {
	key, err := c.freeSamplesKey()
	if err != nil {
		return err
	}
	projectID := id.New()
	if err := c.applyNested("project.create", map[string]any{"id": projectID, "key": key, "name": samplesProject}); err != nil {
		return err
	}
	if err := c.applyNested("label.create", map[string]any{"project": projectID, "name": sampleLabel, "color": sampleColor}); err != nil {
		return err
	}
	firstName := c.actor.Handle
	if words := strings.Fields(c.actor.Name); len(words) > 0 {
		firstName = words[0]
	}
	tasks := []struct{ title, assignee string }{
		{"Open this task and leave a comment", c.actor.UserID},
		{"Write a page in Docs about what you are working on", c.actor.UserID},
		{"Say hello and tell " + firstName + " what you can do", agentID},
	}
	ids := make([]string, len(tasks))
	for i, t := range tasks {
		ids[i] = id.New()
		args := map[string]any{"id": ids[i], "project": projectID, "title": t.title, "labels": []string{sampleLabel}}
		if t.assignee != "" {
			args["assignee"] = t.assignee
		}
		if err := c.applyNested("task.create", args); err != nil {
			return err
		}
	}
	p := newPatch()
	p.put("samples", []string(nil), ids)
	if err := c.save(p, target{table: "projects", entity: "project", id: projectID, place: inProject(projectID)}); err != nil {
		return err
	}
	c.key = key
	return nil
}

// freeSamplesKey is GS, or GS2, GS3… when it is taken. A project in the
// trash keeps its key on its tasks (GS-1 stays that task's), so a key is
// free only when no project has it, in the trash or not.
func (c *cx) freeSamplesKey() (string, error) {
	for n := 1; ; n++ {
		key := samplesKey
		if n > 1 {
			key += strconv.Itoa(n)
		}
		taken, err := c.tx.Count(c.ctx, "projects", store.Eq("key", key))
		if err != nil || taken == 0 {
			return key, err
		}
	}
}

// sampleProjects are the projects made with samples that are not in the
// trash, oldest first.
func (c *cx) sampleProjects() ([]core.Project, error) {
	var projects []core.Project
	err := c.tx.List(c.ctx, &projects, store.Q{Where: []store.Cond{store.NotNull("samples"), store.Live}, Order: "created_seq"})
	return projects, err
}

// samplesThere finds the samples that are there: the project of the first
// that still has a sample task out of the trash.
func (c *cx) samplesThere() (core.Project, bool, error) {
	projects, err := c.sampleProjects()
	if err != nil {
		return core.Project{}, false, err
	}
	for _, p := range projects {
		n, err := c.tx.Count(c.ctx, "tasks", store.In("id", p.Samples), store.Live)
		if err != nil {
			return core.Project{}, false, err
		}
		if n > 0 {
			return p, true, nil
		}
	}
	return core.Project{}, false, nil
}

// samplesRemove sends the sample tasks that are left to the trash, as the
// one who asks deleting them would, and each samples' project with them
// when nothing else is in it: a task or a page the person added keeps it.
// With no samples left it does nothing.
func samplesRemove(c *cx, _ struct{}) error {
	projects, err := c.sampleProjects()
	if err != nil {
		return err
	}
	for _, p := range projects {
		var left []core.Task
		if err := c.tx.List(c.ctx, &left, store.Q{Where: []store.Cond{store.In("id", p.Samples), store.Live}}); err != nil {
			return err
		}
		for _, t := range left {
			if err := c.applyNested("task.delete", map[string]any{"id": t.ID}); err != nil {
				return err
			}
		}
		tasks, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", p.ID), store.Live)
		if err != nil {
			return err
		}
		pages, err := c.tx.Count(c.ctx, "docs", store.Eq("project_id", p.ID), store.Live)
		if err != nil {
			return err
		}
		if tasks == 0 && pages == 0 {
			if err := c.applyNested("project.delete", map[string]any{"id": p.ID}); err != nil {
				return err
			}
		}
	}
	return nil
}
