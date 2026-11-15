package server

import (
	"context"
	"net/http"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// The routes and the timer of repository sources, whose syncing is
// package reposync.

func init() {
	runners = append(runners, func(s *Server, ctx context.Context) { s.repos.Run(ctx) })
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/w/{ws}/sources/{id}/sync", s.workspaceMember(s.handleSyncSource))
		m.HandleFunc("GET /api/v1/w/{ws}/sources", s.workspaceMember(s.handleListSources))
	})
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
	if err := x.admin(); err != nil {
		return err
	}
	var src core.DocSource
	if err := x.db.Get(x.ctx(), &src, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return err
	}
	res, err := s.repos.Sync(x.ctx(), src)
	if err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: err.Error()}
	}
	return x.ok(res)
}
