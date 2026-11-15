// The viewer: who is reading, and what they may see.

package server

import (
	"context"
	"log/slog"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
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

// limited reports whether the viewer is kept to some of the projects.
func (who *viewer) limited() bool { return who.projects != nil }

// limitTo keeps the viewer to the projects named, of those it may read
// already: what a token made for some projects does to its member's reach.
// No project named limits nothing.
func (who *viewer) limitTo(projects []string) {
	if len(projects) == 0 {
		return
	}
	if who.projects == nil {
		who.projects = projects
		return
	}
	var both []string
	for _, p := range projects {
		if slices.Contains(who.projects, p) {
			both = append(both, p)
		}
	}
	if both == nil {
		both = engine.NoProjects() // no project in both
	}
	who.projects = both
}

// canSeeDoc reports whether the viewer may see a page: it is not someone
// else's private page, and it is the workspace's or of a project the viewer
// may read.
func (who *viewer) canSeeDoc(doc core.Doc) bool {
	return engine.CanSeeDoc(doc, who.member.UserID) && who.canProject(doc.ProjectID)
}

// canSeeView reports whether the viewer may see a saved view: it is shared
// or the viewer's own, and it is the workspace's or of a project the viewer
// may read.
func (who *viewer) canSeeView(view core.View) bool {
	return (view.Shared || view.OwnerID == who.member.UserID) && who.canProject(view.ProjectID)
}

// readable is a task filter kept to the projects the viewer may read. Every
// read of tasks that is not of one task by name starts from it, or from
// taskFilter when it is a query.
func (who *viewer) readable(f store.TaskFilter) store.TaskFilter {
	f.ProjectIDs = who.projects
	return f
}

// feed is the filter of the events the viewer may read: those of its
// projects and of no project, and none that is addressed to someone else.
func (who *viewer) feed() store.EventFilter {
	return store.EventFilter{Viewer: who.member.UserID, ProjectIDs: who.projects, AllowNoProject: true}
}

// search finds what the viewer may read by its words: in its projects, and
// not in someone else's private pages. kinds narrows it to some kinds of
// thing; none means all.
func (who *viewer) search(ctx context.Context, text string, kinds []string, limit int) ([]store.SearchHit, error) {
	return who.db.Search(ctx, store.SearchQuery{Text: text, Kinds: kinds, ProjectIDs: who.projects, Viewer: who.member.UserID, Limit: limit})
}

// admin refuses a viewer whose role in the workspace is below admin.
func (who *viewer) admin() error {
	if !who.member.Role.AtLeast(core.RoleAdmin) {
		return errForbidden("this needs the admin role; you are a %s", who.member.Role)
	}
	return nil
}
