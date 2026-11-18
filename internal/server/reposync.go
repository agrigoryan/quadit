package server

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/reposync"
	"github.com/agrigoryan/quadit/internal/store"
)

// The routes of repository sources, whose syncing is package reposync.

// sourceRoutes are the routes of repository sources.
func (s *Server) sourceRoutes() []route {
	return []route{
		{"POST /api/v1/w/{ws}/sources/{id}/sync", s.workspaceMember(s.handleSyncSource), "Sync one repository source now; answers with what moved each way.", "", "docs"},
		{"GET /api/v1/w/{ws}/sources", s.workspaceMember(s.handleListSources), "The repository sources that pages sync with, with their last sync and error.", "", "docs"},
	}
}

// handleListSources lists the workspace's repository sources.
func (s *Server) handleListSources(x *c) error {
	var list []core.DocSource
	if err := x.db.List(x.ctx(), &list, store.Where(store.Live)); err != nil {
		return err
	}
	return x.ok(map[string]any{"sources": list})
}

// handleSyncSource syncs a source now and says what the sync did.
func (s *Server) handleSyncSource(x *c) error {
	if err := x.mayAdminister(); err != nil {
		return err
	}
	var src core.DocSource
	if err := x.db.Get(x.ctx(), &src, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return err
	}
	res, err := s.repos.Sync(x.ctx(), src)
	if reposync.Conflict(err) {
		return &engine.Error{Code: engine.CodeConflict, Message: err.Error()}
	}
	if err != nil {
		return err
	}
	return x.ok(res)
}
