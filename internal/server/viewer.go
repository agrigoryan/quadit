// The viewer: who is reading, and what they may see.

package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// viewer is who a read is made for: a member of one workspace, limited to
// some of its projects or not. Every read of the workspace's data is a
// method of it that takes a ctx, so the same code answers a request (where
// the viewer is part of the request context c), the dispatcher and a
// webhook's delivery (viewerFor), and none of them needs a request to exist.
//
// What a viewer may see is asked of it: canProject for a project and what
// belongs to one, canSeeDoc, canSeeView and canSeeFile for the things with
// a rule of their own, readable, taskFilter, feed and search for reads of
// many, and for rows given as they are stored the rule of each kind
// (rowkinds.go). A read does not compare project ids itself.
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
	// nameCache is the workspace's names, read once (names).
	nameCache *nameLookup
}

// viewerFor returns the viewer a member of a workspace is, with the limits
// of the membership. A request narrows it further by its token
// (enterWorkspace); work the server does on its own reads as the member
// itself. With a zero member it is nobody: good for naming things (the line
// of text a webhook is sent), and not to be asked for what is one member's
// own, since the feed's filter takes no member to mean every member.
func (s *Server) viewerFor(ws core.Workspace, member core.Member) *viewer {
	who := &viewer{ws: ws, member: member, db: s.st.In(ws.ID), st: s.st, baseURL: s.cfg.BaseURL, log: s.log}
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

// readableTasks answers, for one run of rows, whether the viewer may read
// a task by its id: whether it is of a project the viewer may read. Each
// task is read once. A task that cannot be read is one the viewer may not.
func (who *viewer) readableTasks(ctx context.Context) func(taskID string) bool {
	may := map[string]bool{}
	return func(taskID string) bool {
		readable, asked := may[taskID]
		if !asked {
			var t core.Task
			readable = who.db.Get(ctx, &t, store.Eq("id", taskID)) == nil && who.canProject(t.ProjectID)
			may[taskID] = readable
		}
		return readable
	}
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

// readFeed reads the events a filter selects, each as the viewer may see it
// (asSeen). The filter says which events are the viewer's to read (feed, or
// one made for a task or a page the viewer was let into).
func (who *viewer) readFeed(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	evs, err := who.db.Events(ctx, f)
	if err != nil {
		return nil, err
	}
	return who.asSeen(ctx, evs), nil
}

// asSeen is events the viewer was let read, each without what it says of
// a task the viewer may not read: the far end of a relation, its id and its
// key; and without what a link to a page the viewer may not see says. The
// events are changed in place.
func (who *viewer) asSeen(ctx context.Context, evs []core.Event) []core.Event {
	for i, ev := range evs {
		if ev.EntityType == "link" && !who.seesLink(ctx, ev.EntityID) {
			evs[i].Data = json.RawMessage(`{}`)
		}
	}
	if !who.limited() {
		return evs
	}
	mayRead := who.readableTasks(ctx)
	for i, ev := range evs {
		if ev.Type != "relation.created" && ev.Type != "task.related" {
			continue
		}
		// The data is changed key by key, so that what is not taken out
		// goes on as it was written. Data that does not read is not given.
		payload, err := ev.Payload()
		var data map[string]json.RawMessage
		if err != nil || json.Unmarshal(ev.Data, &data) != nil {
			evs[i].Data = json.RawMessage(`{}`)
			continue
		}
		if ev.Type == "relation.created" {
			// The relation's own event carries its row; key and other_key
			// are the keys of the tasks at its two ends.
			var r core.Relation
			payload.ReadRow(&r)
			r = withoutHiddenEnds(r, mayRead)
			data["row"] = plainjson.Marshal(r)
			if r.TaskID == "" {
				delete(data, "key")
			}
			if r.RelatedTaskID == "" {
				delete(data, "other_key")
			}
		} else if other, err := who.resolver(ctx).Task(payload.OtherKey); err != nil || !who.canProject(other.ProjectID) {
			// What the task at one end is told of the relation names the
			// task at the other end by other_id and other_key alone.
			delete(data, "other_id")
			delete(data, "other_key")
		}
		evs[i].Data = plainjson.Marshal(data)
	}
	return evs
}

// search finds what the viewer may read by its words: what is of its
// projects or of none, and of no private page that is not the viewer's or
// shared with it; exactly what canProject and canSeeDoc let it open. kinds narrows it to some kinds of
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
