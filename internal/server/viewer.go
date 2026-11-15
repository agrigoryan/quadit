// The viewer: who is reading, and what they may see.

package server

import (
	"context"
	"log/slog"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// viewer is who a read is made for: a member of one workspace, limited to
// some of its projects or not. Every read of the workspace's data is a
// method of it that takes a ctx, so the same code answers a request (where
// the viewer is part of the request context c), the dispatcher and a
// webhook's delivery (viewerFor), and none of them needs a request to exist.
//
// What a viewer may see is decided here and nowhere else: canProject for a
// project and what belongs to one, and the methods beside it for the kinds
// of row whose rule is their own.
type viewer struct {
	ws     core.Workspace
	member core.Member
	// projects, when not nil, are the only projects the viewer may read: the
	// membership's scope, narrowed by a token's when one is used. nil lets
	// in every project; engine.NoProjects() lets in none.
	projects []string
	db       store.DB // bound to ws
	// st is the whole store, for what belongs to no workspace: the
	// workspace's own row, and people's accounts.
	st      store.Store
	baseURL string       // where people reach the server, for addresses in answers
	log     *slog.Logger // for a read that shows less instead of failing
	// agentUsage sums what an agent's sessions cost since a time
	// (engine.Usage).
	agentUsage func(ctx context.Context, db store.DB, agentID string, since int64) (costMicros, minutes int64, err error)
	// nameCache is the workspace's names, read once (names).
	nameCache *nameLookup
}

// viewerFor returns the viewer a member of a workspace is, with the limits
// of the membership. A request narrows it further by its token
// (enterWorkspace); work the server does on its own reads as the member
// itself. A zero member is nobody in particular: it sees every project, and
// nothing that is one person's own.
func (s *Server) viewerFor(ws core.Workspace, member core.Member) *viewer {
	who := &viewer{ws: ws, member: member, db: s.st.In(ws.ID), st: s.st, baseURL: s.cfg.BaseURL, log: s.log, agentUsage: s.eng.Usage}
	if member.Scope != nil {
		who.projects = member.Scope.Projects
	}
	return who
}

// canProject reports whether the viewer may read a project. What belongs to
// no project ("") is the workspace's, and open to every member.
func (who *viewer) canProject(projectID string) bool {
	return who.projects == nil || projectID == "" || slices.Contains(who.projects, projectID)
}

// admin refuses a viewer whose role in the workspace is below admin.
func (who *viewer) admin() error {
	if !who.member.Role.AtLeast(core.RoleAdmin) {
		return errForbidden("this needs the admin role; you are a %s", who.member.Role)
	}
	return nil
}
