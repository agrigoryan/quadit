// The kinds of row a workspace holds, and who may see a row of each.

package server

import (
	"context"
	"reflect"
	"regexp"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// rowKind is one kind of row a workspace holds, as the reads that give rows
// as they are stored know it: /list/{name}, the starting copy (/bootstrap)
// and data/ of an export. Each of those goes through rowKinds, so a new
// kind is one line there: its name, the rule for who may see a row of it,
// and which of the three reads have it.
//
// The rule is not optional. /list and the starting copy read through
// rowKind.read, which applies it; a kind cannot be given to a caller
// limited to some projects without saying what such a caller may see of it.
type rowKind struct {
	name string
	row  reflect.Type // the row's type, a struct of core
	// all reads the rows a query selects, as stored: a list of the row's type.
	all func(ctx context.Context, db store.DB, q store.Q) (any, error)
	// visible keeps, of a list all read, the rows the viewer may see.
	visible func(ctx context.Context, who *viewer, rows any) any
	// fill, when the kind has one, fills in what a row is shown with and is
	// not stored: who answers for an agent, a file's address.
	fill func(ctx context.Context, who *viewer, rows any) error

	// list is how /list/{name} lists the kind; nil when it does not.
	list *listing
	// copyQuery selects the rows the starting copy brings; nil when it brings none.
	copyQuery func(who *viewer) store.Q
	// exportQuery selects the rows data/ of an export holds; nil when it holds none.
	exportQuery *store.Q
}

// listing is how /list/{name} lists a kind.
type listing struct {
	admin bool         // only admins may list it
	order string       // the order its rows come in
	conds []store.Cond // which rows, besides what the URL narrows it to
	// query, when set, reads the query from the request in the kind's own
	// way, in place of the narrowing every other list has (listQuery).
	query func(x *c) (store.Q, error)
	// also, when set, adds what only a list shows, after the rows are read.
	also func(ctx context.Context, who *viewer, rows any)
}

// read lists the rows a query selects and the viewer may see, each filled
// in as the kind is shown. The list is never nil.
func (k rowKind) read(ctx context.Context, who *viewer, q store.Q) (any, error) {
	rows, err := k.all(ctx, who.db, q)
	if err != nil {
		return nil, err
	}
	rows = k.visible(ctx, who, rows)
	if k.fill != nil {
		if err := k.fill(ctx, who, rows); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// rule says which rows of a kind a viewer may see: it returns, of rows, the
// ones to keep. A rule that must read to decide and cannot, keeps nothing
// it is unsure of.
type rule[T any] func(ctx context.Context, who *viewer, rows []T) []T

// kindOf makes a kind of rows of type T with the rule for who may see them.
func kindOf[T any](name string, visible rule[T]) rowKind {
	if visible == nil {
		panic("row kind " + name + " has no rule for who may see its rows")
	}
	return rowKind{
		name: name,
		row:  reflect.TypeFor[T](),
		all: func(ctx context.Context, db store.DB, q store.Q) (any, error) {
			var rows []T
			err := db.List(ctx, &rows, q)
			return rows, err
		},
		visible: func(ctx context.Context, who *viewer, rows any) any {
			kept := visible(ctx, who, rows.([]T))
			if kept == nil {
				kept = []T{}
			}
			return kept
		},
	}
}

// filled is a kind whose rows are filled in by fill after they are read.
func filled[T any](k rowKind, fill func(ctx context.Context, who *viewer, rows []T) error) rowKind {
	k.fill = func(ctx context.Context, who *viewer, rows any) error { return fill(ctx, who, rows.([]T)) }
	return k
}

// listed is the kind as /list/{name} lists it: in an order, with conds.
func (k rowKind) listed(order string, conds ...store.Cond) rowKind {
	k.list = &listing{order: order, conds: conds}
	return k
}

// adminsOnly is the listed kind kept to admins.
func (k rowKind) adminsOnly() rowKind {
	list := *k.list
	list.admin = true
	k.list = &list
	return k
}

// copied is the kind as the starting copy brings it: the rows q selects.
func (k rowKind) copied(q func(who *viewer) store.Q) rowKind {
	k.copyQuery = q
	return k
}

// exported is the kind as data/ of an export holds it: the rows q selects.
func (k rowKind) exported(q store.Q) rowKind {
	k.exportQuery = &q
	return k
}

// The rules.

// everyMember is the rule of a kind every member sees whole: it belongs to
// no project. (A kind only admins may list says so where it is listed.)
func everyMember[T any]() rule[T] {
	return func(_ context.Context, _ *viewer, rows []T) []T { return rows }
}

// ifViewer is the rule of a kind the viewer itself has a rule for.
func ifViewer[T any](may func(who *viewer, row T) bool) rule[T] {
	return func(_ context.Context, who *viewer, rows []T) []T {
		return keep(rows, func(row T) bool { return may(who, row) })
	}
}

// ofProject is the rule of a kind whose rows are each of a project, or of
// the workspace: a row is seen by whoever may read its project.
func ofProject[T any](projectOf func(T) string) rule[T] {
	return ifViewer(func(who *viewer, row T) bool { return who.canProject(projectOf(row)) })
}

// ownOnly is the rule of a kind whose rows are each one member's own.
func ownOnly[T any](userOf func(T) string) rule[T] {
	return ifViewer(func(who *viewer, row T) bool { return userOf(row) == who.member.UserID })
}

// onTask is the rule of a kind whose rows hang on a task: a row is seen by
// whoever may read the task's project, and a row on no task by everyone. A
// task that cannot be read counts as in no project the viewer may read.
func onTask[T any](taskOf func(T) string) rule[T] {
	return func(ctx context.Context, who *viewer, rows []T) []T {
		if !who.limited() {
			return rows
		}
		projectOf := map[string]string{}
		return keep(rows, func(row T) bool {
			taskID := taskOf(row)
			if taskID == "" {
				return true
			}
			projectID, seen := projectOf[taskID]
			if !seen {
				var t core.Task
				projectID = "none"
				if who.db.Get(ctx, &t, store.Eq("id", taskID)) == nil {
					projectID = t.ProjectID
				}
				projectOf[taskID] = projectID
			}
			return who.canProject(projectID)
		})
	}
}

// onEpic is the rule of a kind whose rows hang on an epic: a row is seen by
// whoever may read the epic's project. An epic that cannot be read counts
// as in no project the viewer may read.
func onEpic[T any](epicOf func(T) string) rule[T] {
	return func(ctx context.Context, who *viewer, rows []T) []T {
		if !who.limited() {
			return rows
		}
		projectOf := map[string]string{}
		return keep(rows, func(row T) bool {
			epicID := epicOf(row)
			projectID, seen := projectOf[epicID]
			if !seen {
				var epic core.Epic
				projectID = "none"
				if who.db.Get(ctx, &epic, store.Eq("id", epicID)) == nil {
					projectID = epic.ProjectID
				}
				projectOf[epicID] = projectID
			}
			return who.canProject(projectID)
		})
	}
}

// wholeOnly is the rule of a kind that is read only as part of the whole
// workspace (an export): a viewer limited to some projects sees none of it.
// A kind gets a rule of its own before it is listed or copied.
func wholeOnly[T any]() rule[T] {
	return func(_ context.Context, who *viewer, rows []T) []T {
		if who.limited() {
			return nil
		}
		return rows
	}
}

// live selects the rows not in the trash, in an order.
func live(order string) store.Q { return store.Q{Where: []store.Cond{store.Live}, Order: order} }

// toEveryone is a query of the starting copy that is the same whoever reads.
func toEveryone(q store.Q) func(*viewer) store.Q { return func(*viewer) store.Q { return q } }

// The starting copy brings the latest copyLatest notifications and agent
// sessions, and the sessions of the last copySessionsFor.
const (
	copyLatest      = 300
	copySessionsFor = 7 * 24 * time.Hour
)

// rowKinds are the kinds of row, in the order data/ of an export holds
// them. Tasks and events are not here: each has reads of its own (a task
// list, the feed), and the starting copy and the export read them page by
// page.
var rowKinds = []rowKind{
	filled(kindOf("members", everyMember[core.Member]()), fillMembers).
		listed("handle").withEmailsForAdmins().copied(toEveryone(store.Q{Order: "handle"})).exported(store.Q{}),
	kindOf("projects", ifViewer(func(who *viewer, p core.Project) bool { return who.canProject(p.ID) })).
		listed("rank").copied(toEveryone(live("rank"))).exported(live("")),
	kindOf("statuses", ofProject(func(s core.Status) string { return s.ProjectID })).
		listed("rank").copied(toEveryone(live("rank"))).exported(live("")),
	kindOf("labels", ofProject(func(l core.Label) string { return l.ProjectID })).
		listed("name").copied(toEveryone(live("name"))).exported(live("")),
	kindOf("epics", ofProject(func(e core.Epic) string { return e.ProjectID })).
		listed("rank").copied(toEveryone(live("rank"))).exported(live("")),
	kindOf("milestones", onEpic(func(m core.Milestone) string { return m.EpicID })).
		listed("rank").copied(toEveryone(live("rank"))).exported(live("")),
	kindOf("cycles", ofProject(func(cy core.Cycle) string { return cy.ProjectID })).
		listed("starts_on").copied(toEveryone(live("starts_on"))).exported(live("")),
	kindOf("decisions", onTask(func(d core.Decision) string { return d.TaskID })).
		copied(toEveryone(live("created_seq"))).exported(live("created_seq")),
	kindOf("decision_options", wholeOnly[core.Option]()).exported(live("rank")),
	kindOf("comments", wholeOnly[core.Comment]()).exported(live("created_seq")),
	kindOf("relations", onTask(func(r core.Relation) string { return r.TaskID })).
		listed("created_at").copied(toEveryone(store.Q{})).exported(store.Q{}),
	kindOf("links", onTask(func(l core.TaskLink) string { return l.TaskID })).
		listed("created_at").exported(live("")),
	filled(kindOf("attachments", rule[core.Attachment](visibleAttachments)), fillAttachments).
		listedBy(attachmentsQuery).exported(live("")),
	kindOf("files", wholeOnly[core.File]()).exported(live("")),
	kindOf("docs", ifViewer((*viewer).canSeeDoc)).
		copied(toEveryone(live("rank"))).exported(live("rank")),
	kindOf("blocks", wholeOnly[core.Block]()).exported(live("rank")),
	kindOf("properties", wholeOnly[core.DBProperty]()).exported(live("rank")),
	kindOf("preferences", ofProject(func(p core.Preference) string { return p.ProjectID })).
		listed("created_at").copied(toEveryone(live(""))).exported(live("")),
	kindOf("views", ifViewer((*viewer).canSeeView)).
		listed("rank").copied(toEveryone(live("rank"))).exported(live("")),

	kindOf("templates", ofProject(func(t core.Template) string { return t.ProjectID })).
		listed("name").copied(toEveryone(live("name"))),
	kindOf("resources", everyMember[core.Resource]()).
		listed("name").copied(toEveryone(live(""))),
	kindOf("claims", onTask(func(cl core.ResourceClaim) string { return cl.TaskID })).
		listed("requested_at", store.Ne("state", core.ClaimReleased)).copied(toEveryone(store.Where(store.Ne("state", core.ClaimReleased)))),
	kindOf("sessions", onTask(func(s core.AgentSession) string { return s.TaskID })).
		listed("-started_at").copied(func(*viewer) store.Q {
		return store.Q{Where: []store.Cond{store.Gte("started_at", time.Now().Add(-copySessionsFor).UnixMilli())}, Order: "-started_at", Limit: copyLatest}
	}),
	kindOf("notifications", ownOnly(func(n core.Notification) string { return n.UserID })).
		copied(func(who *viewer) store.Q {
			return store.Q{Where: []store.Cond{store.Eq("user_id", who.member.UserID), store.Null("archived_at")}, Order: "-seq", Limit: copyLatest}
		}),
	kindOf("watchers", ownOnly(func(w core.Watcher) string { return w.UserID })).
		copied(func(who *viewer) store.Q { return store.Where(store.Eq("user_id", who.member.UserID)) }),
	kindOf("secrets", everyMember[core.Secret]()).listed("name").adminsOnly(),
	kindOf("webhooks", ofProject(func(h core.Webhook) string { return h.ProjectID })).listed("name").adminsOnly(),
	kindOf("deliveries", everyMember[core.WebhookDelivery]()).listed("-created_at").adminsOnly(),
	kindOf("rules", everyMember[core.Rule]()).listed("name").adminsOnly(),
	filled(kindOf("integrations", ofProject(func(in core.Integration) string { return in.ProjectID })), func(_ context.Context, _ *viewer, rows []core.Integration) error {
		for i := range rows {
			rows[i].HasSecret = rows[i].Secret != ""
		}
		return nil
	}).listed("created_at").adminsOnly(),
}

// rowKindNamed finds a kind by its name.
func rowKindNamed(name string) (rowKind, bool) {
	for _, kind := range rowKinds {
		if kind.name == name {
			return kind, true
		}
	}
	return rowKind{}, false
}

// Members.

// fillMembers gives each agent the person who answers for it, and blanks
// what a member last did where the viewer may not read the task it names.
func fillMembers(ctx context.Context, who *viewer, members []core.Member) error {
	withResponsible(ctx, who.st, who.log, members)
	who.hideActions(ctx, members)
	return nil
}

// withEmailsForAdmins is the listed kind of members with people's
// addresses, for a viewer who is an admin: admins invite and import by them.
func (k rowKind) withEmailsForAdmins() rowKind {
	list := *k.list
	list.also = func(ctx context.Context, who *viewer, rows any) {
		members := rows.([]core.Member)
		if !who.member.Role.AtLeast(core.RoleAdmin) {
			return
		}
		var ids []string
		for _, m := range members {
			if m.Kind == core.KindPerson {
				ids = append(ids, m.UserID)
			}
		}
		var users []core.User
		// Best effort: the list is shown without addresses when they cannot be read.
		if len(ids) > 0 && who.st.List(ctx, &users, store.Where(store.In("id", ids))) == nil {
			emailOf := map[string]string{}
			for _, u := range users {
				emailOf[u.ID] = u.Email
			}
			for i := range members {
				members[i].Email = emailOf[members[i].UserID]
			}
		}
	}
	k.list = &list
	return k
}

// taskKeyIn finds a task key ("SVA-12") in a line of text.
var taskKeyIn = regexp.MustCompile(`\b([A-Z][A-Z0-9]{1,9})-\d+\b`)

// hideActions blanks, for a viewer limited to some projects, what a member
// last did when it names a task of another project.
func (who *viewer) hideActions(ctx context.Context, members []core.Member) {
	if !who.limited() {
		return
	}
	// When the projects cannot be read, mine stays empty and every action
	// that names a task is hidden: this fails closed.
	mine := map[string]bool{}
	var projects []core.Project
	if err := who.db.List(ctx, &projects, store.Q{}); err == nil {
		for _, p := range projects {
			mine[p.Key] = who.canProject(p.ID)
		}
	}
	for i := range members {
		for _, m := range taskKeyIn.FindAllStringSubmatch(members[i].LastAction, -1) {
			if !mine[m[1]] {
				members[i].LastAction = ""
				break
			}
		}
	}
}

// Attachments.

// visibleAttachments is the rule of attachments. One on a task (on the
// task itself, or on a comment, a decision or an option of it) is seen by
// whoever may read the task's project; one on a page by whoever may see
// the page. A task or a page that cannot be read hides what is on it.
func visibleAttachments(ctx context.Context, who *viewer, atts []core.Attachment) []core.Attachment {
	return keep(atts, func(a core.Attachment) bool {
		if a.TaskID != "" {
			var t core.Task
			return who.db.Get(ctx, &t, store.Eq("id", a.TaskID)) == nil && who.canProject(t.ProjectID)
		}
		if a.SubjectType != "doc" {
			return true
		}
		var page core.Doc
		return who.db.Get(ctx, &page, store.Eq("id", a.SubjectID)) == nil && who.canSeeDoc(page)
	})
}

// fillAttachments gives each attachment its file, with its address.
func fillAttachments(ctx context.Context, who *viewer, atts []core.Attachment) error {
	byID, err := who.attachedFiles(ctx, atts)
	if err != nil {
		return err
	}
	for i := range atts {
		if f, ok := byID[atts[i].FileID]; ok {
			atts[i].File = &f
		}
	}
	return nil
}

// listedBy is the kind as /list/{name} lists it when it reads its own
// query from the request.
func (k rowKind) listedBy(query func(x *c) (store.Q, error)) rowKind {
	k.list = &listing{query: query}
	return k
}

// attachmentsQuery reads which attachments /list/attachments is asked for:
// the latest thousand; task= narrows to one task the caller may read, and
// trash=1 lists the removed ones, which attachment.restore puts back.
func attachmentsQuery(x *c) (store.Q, error) {
	conds := []store.Cond{store.Live}
	if truthyParam(x.r.URL.Query(), "trash") {
		conds = []store.Cond{store.NotNull("deleted_at")}
	}
	if ref := x.r.URL.Query().Get("task"); ref != "" {
		t, err := x.taskByRef(x.ctx(), ref)
		if err != nil {
			return store.Q{}, err
		}
		conds = append(conds, store.Eq("task_id", t.ID))
	}
	return store.Q{Where: conds, Order: "-created_at", Limit: 1000}, nil
}
