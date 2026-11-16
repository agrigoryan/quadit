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
// The rule is not optional for what a caller limited to some projects may
// be given: /list and the starting copy read through rowKind.read, which
// applies it. A kind only the export reads (exportOnly) has none, as the
// export is the whole workspace's and is refused to such a caller; it is
// never listed or copied (TestOnlyAKindWithARuleIsListedOrCopied).
type rowKind struct {
	name string
	row  reflect.Type // the row's type, a struct of core
	// all reads the rows a query selects, as stored: a list of the row's type.
	all func(ctx context.Context, db store.DB, q store.Q) (any, error)
	// visible keeps, of a list all read, the rows the viewer may see; nil
	// for a kind only the export reads.
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

// readUpToLimit is read for a query with a limit, counted among the rows
// the viewer may see: it reads page after page of q until the limit is
// met or the rows run out, so that rows the viewer may not see do not
// leave the list short while there are more it may. A query with no limit
// is read as it is.
func (k rowKind) readUpToLimit(ctx context.Context, who *viewer, q store.Q) (any, error) {
	if q.Limit == 0 {
		return k.read(ctx, who, q)
	}
	seen := reflect.MakeSlice(reflect.SliceOf(k.row), 0, q.Limit)
	for page := q; seen.Len() < q.Limit; page.Offset += page.Limit {
		rows, err := k.all(ctx, who.db, page)
		if err != nil {
			return nil, err
		}
		read := reflect.ValueOf(rows).Len()
		seen = reflect.AppendSlice(seen, reflect.ValueOf(k.visible(ctx, who, rows)))
		if read < page.Limit {
			break
		}
	}
	rows := seen.Slice(0, min(seen.Len(), q.Limit)).Interface()
	if k.fill != nil {
		if err := k.fill(ctx, who, rows); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// rule says which rows of a kind a viewer may see: it returns, of rows, the
// ones to keep, each without what the viewer may not see of it (the far
// end of a relation). A rule that must read to decide and cannot, keeps
// nothing it is unsure of.
type rule[T any] func(ctx context.Context, who *viewer, rows []T) []T

// kindOf makes a kind of rows of type T with the rule for who may see them.
func kindOf[T any](name string, visible rule[T]) rowKind {
	if visible == nil {
		panic("row kind " + name + " has no rule for who may see its rows")
	}
	return rowKind{
		name: name,
		row:  reflect.TypeFor[T](),
		all:  allRows[T],
		visible: func(ctx context.Context, who *viewer, rows any) any {
			kept := visible(ctx, who, rows.([]T))
			if kept == nil {
				kept = []T{}
			}
			return kept
		},
	}
}

// exportOnly makes a kind of rows of type T that only data/ of an export
// holds, the rows q selects, as stored. It has no rule for who may see a
// row, so it is never listed or put in the starting copy.
func exportOnly[T any](name string, q store.Q) rowKind {
	return rowKind{name: name, row: reflect.TypeFor[T](), all: allRows[T], exportQuery: &q}
}

// allRows reads the rows a query selects, as stored: a list of T.
func allRows[T any](ctx context.Context, db store.DB, q store.Q) (any, error) {
	var rows []T
	err := db.List(ctx, &rows, q)
	return rows, err
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

// onTask is the rule of a kind whose rows hang on a task: a row is seen by
// whoever may read the task's project, and a row on no task by everyone. A
// task that cannot be read counts as in no project the viewer may read.
func onTask[T any](taskOf func(T) string) rule[T] {
	return func(ctx context.Context, who *viewer, rows []T) []T {
		if !who.limited() {
			return rows
		}
		mayRead := who.readableTasks(ctx)
		return keep(rows, func(row T) bool {
			taskID := taskOf(row)
			return taskID == "" || mayRead(taskID)
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

// live selects the rows not in the trash, in an order.
func live(order string) store.Q { return store.Q{Where: []store.Cond{store.Live}, Order: order} }

// toEveryone is a query of the starting copy that is the same whoever reads.
func toEveryone(q store.Q) func(*viewer) store.Q { return func(*viewer) store.Q { return q } }

// The starting copy brings the latest copyLatest notifications and agent
// sessions the viewer may see, and the sessions of the last copySessionsFor.
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
	exportOnly[core.Option]("decision_options", live("rank")),
	exportOnly[core.Comment]("comments", live("created_seq")),
	kindOf("relations", rule[core.Relation](visibleRelations)).
		listedBy(relationsQuery).copied(toEveryone(store.Q{})).exported(store.Q{}),
	kindOf("links", onTask(func(l core.TaskLink) string { return l.TaskID })).
		listed("created_at,id").exported(live("")),
	filled(kindOf("attachments", rule[core.Attachment](visibleAttachments)), fillAttachments).
		listedBy(attachmentsQuery).exported(live("")),
	exportOnly[core.File]("files", live("")),
	kindOf("docs", ifViewer((*viewer).canSeeDoc)).
		copied(toEveryone(live("rank"))).exported(live("rank")),
	exportOnly[core.Block]("blocks", live("rank")),
	exportOnly[core.DBProperty]("properties", live("rank")),
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
		listed("-started_at,id").copied(func(*viewer) store.Q {
		return store.Q{Where: []store.Cond{store.Gte("started_at", time.Now().Add(-copySessionsFor).UnixMilli())}, Order: "-started_at,id", Limit: copyLatest}
	}),
	kindOf("notifications", rule[core.Notification](visibleNotifications)).
		copied(func(who *viewer) store.Q {
			return store.Q{Where: []store.Cond{store.Eq("user_id", who.member.UserID), store.Null("archived_at")}, Order: "-seq", Limit: copyLatest}
		}),
	kindOf("watchers", rule[core.Watcher](visibleWatchers)).
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

// Relations.

// visibleRelations is the rule of relations. One is seen by whoever may
// read the task at either end of it. Of an end the viewer may not read
// they are told nothing: its id is blank in the row they get, so the row
// says only that the task they do read is related to one they cannot see.
func visibleRelations(ctx context.Context, who *viewer, relations []core.Relation) []core.Relation {
	if !who.limited() {
		return relations
	}
	mayRead := who.readableTasks(ctx)
	seen := make([]core.Relation, 0, len(relations))
	for _, r := range relations {
		if r = withoutHiddenEnds(r, mayRead); r.TaskID != "" || r.RelatedTaskID != "" {
			seen = append(seen, r)
		}
	}
	return seen
}

// withoutHiddenEnds is a relation with the id of each end blank that is a
// task the viewer may not read (mayRead).
func withoutHiddenEnds(r core.Relation, mayRead func(taskID string) bool) core.Relation {
	if !mayRead(r.TaskID) {
		r.TaskID = ""
	}
	if !mayRead(r.RelatedTaskID) {
		r.RelatedTaskID = ""
	}
	return r
}

// A member's own rows.

// visibleNotifications is the rule of inbox items. One is seen by the
// member it is for, and only while they may read what it is about: a task
// of a project they may read, a page they may see. So a token made for some
// projects shows its member's inbox of those projects alone, and an item
// about a task of a project the member was since kept out of is not shown.
func visibleNotifications(ctx context.Context, who *viewer, notes []core.Notification) []core.Notification {
	notes = keep(notes, func(n core.Notification) bool { return n.UserID == who.member.UserID })
	if !who.limited() {
		return notes
	}
	mayRead := who.readableTasks(ctx)
	return keep(notes, func(n core.Notification) bool {
		if n.TaskID != "" && !mayRead(n.TaskID) {
			return false
		}
		var page core.Doc
		return n.DocID == "" || who.db.Get(ctx, &page, store.Eq("id", n.DocID)) == nil && who.canSeeDoc(page)
	})
}

// visibleWatchers is the rule of what members watch. A row is seen by the
// member who watches, and only while they may see what is watched: so a
// token made for some projects does not say that its member follows a task,
// an epic, a project, a view or a page of another. A row of a kind of thing
// this does not know is not shown.
func visibleWatchers(ctx context.Context, who *viewer, watchers []core.Watcher) []core.Watcher {
	mayRead := who.readableTasks(ctx)
	return keep(watchers, func(watching core.Watcher) bool {
		if watching.UserID != who.member.UserID {
			return false
		}
		switch watching.SubjectType {
		case "task":
			return !who.limited() || mayRead(watching.SubjectID)
		case "project":
			return who.canProject(watching.SubjectID)
		case "epic":
			var epic core.Epic
			return who.db.Get(ctx, &epic, store.Eq("id", watching.SubjectID)) == nil && who.canProject(epic.ProjectID)
		case "view":
			var view core.View
			return who.db.Get(ctx, &view, store.Eq("id", watching.SubjectID)) == nil && who.canSeeView(view)
		case "doc":
			var page core.Doc
			return who.db.Get(ctx, &page, store.Eq("id", watching.SubjectID)) == nil && who.canSeeDoc(page)
		}
		return false
	})
}

// relationsQuery reads which relations /list/relations is asked for, in
// the order they were made: task= narrows to those the task is at either
// end of, and limit= and offset= page it as every list is paged. The task
// must be one the caller may read: asked by a task they may not, the list
// would say which task the blank end of a relation is.
func relationsQuery(x *c) (store.Q, error) {
	q := store.Q{Order: "created_at,id", Limit: min(x.intParam("limit", 1000), 5000), Offset: x.intParam("offset", 0)}
	if ref := x.r.URL.Query().Get("task"); ref != "" {
		t, err := x.taskByRef(x.ctx(), ref)
		if err != nil {
			return store.Q{}, err
		}
		q.Where = []store.Cond{store.Either(store.Eq("task_id", t.ID), store.Eq("related_task_id", t.ID))}
	}
	return q, nil
}

// Attachments.

// visibleAttachments is the rule of attachments. One on a task (on the
// task itself, or on a comment, a decision or an option of it) is seen by
// whoever may read the task's project; one on a page, or on a comment on a
// page, by whoever may see the page. A task or a page that cannot be read
// hides what is on it, and so does being on neither.
func visibleAttachments(ctx context.Context, who *viewer, atts []core.Attachment) []core.Attachment {
	return keep(atts, func(a core.Attachment) bool {
		if a.TaskID != "" {
			var t core.Task
			return who.db.Get(ctx, &t, store.Eq("id", a.TaskID)) == nil && who.canProject(t.ProjectID)
		}
		page, there, err := attachmentPage(ctx, who.db, a)
		return err == nil && there && who.canSeeDoc(page)
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
