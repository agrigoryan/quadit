package server

import (
	"net/http"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
)

// The sample tasks to try Quadit with, as the web app and the desktop app
// ask for them: the changes samples.add and samples.remove
// (internal/engine/ch_samples.go), answered the way a REST caller expects.
// An install starts with them (handleSetUpInstall); a workspace made later
// gets them here.

// sampleRoutes are the routes of the sample tasks.
func (s *Server) sampleRoutes() []route {
	return []route{
		{"POST /api/v1/w/{ws}/samples", s.workspaceMember(s.handleAddSamples), "Sample tasks to try Quadit with: a project \"Getting started\" (key GS, or the next free one) with three tasks marked by the label Sample, the first two for the caller and the third for the agent named in the body {agent} (an agent member's id or @handle), or for nobody. Answers 201 with {project}. While the samples are there it makes nothing and answers 200 with the same project, after giving the third task to the agent named when that task is still there and has nobody. Owners and admins.", "", "write"},
		{"DELETE /api/v1/w/{ws}/samples", s.workspaceMember(s.handleRemoveSamples), "Sends the sample tasks that are left to the trash, as deleting them would, and their project with them when nothing else is in it. Owners and admins.", "", "write"},
	}
}

// handleAddSamples applies samples.add and answers with the samples'
// project: 201 when this call made it.
func (s *Server) handleAddSamples(x *c) error {
	var b struct {
		Agent string `json:"agent"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	res, err := s.eng.Apply(x.ctx(), x.ws.ID, x.actor, engine.Change{ID: id.New(), Type: "samples.add", Args: plainjson.Marshal(b)})
	if err != nil {
		return err
	}
	project, err := x.resolver(x.ctx()).Project(res.Ref)
	if err != nil {
		return err
	}
	if !x.canProject(project.ID) {
		return errNotFound("project " + project.Key)
	}
	status := 200
	if slices.ContainsFunc(res.Events, func(ev core.Event) bool { return ev.Type == "project.created" }) {
		status = 201
	}
	return x.json(status, map[string]any{"project": project})
}

// handleRemoveSamples applies samples.remove.
func (s *Server) handleRemoveSamples(x *c) error {
	if _, err := s.eng.Apply(x.ctx(), x.ws.ID, x.actor, engine.Change{ID: id.New(), Type: "samples.remove", Args: []byte(`{}`)}); err != nil {
		return err
	}
	x.w.WriteHeader(http.StatusNoContent)
	return nil
}
