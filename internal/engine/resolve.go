// Finding rows by what people call them: a key, a @handle, a name or an id.

package engine

import (
	"context"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Changes name things the way people do: a project by its key, a task by
// SVA-12, a member by @handle, a status or label by its name. Ids work too.
// The functions here turn such a reference into the row, and when it matches
// nothing they say what would have.

// Resolver turns references into rows for one member, over a transaction
// or a plain read.
type Resolver struct {
	ctx   context.Context
	db    store.DB
	actor core.Member
	at    int64
}

// NewResolver returns a Resolver for reads outside a change.
func NewResolver(ctx context.Context, db store.DB, actor core.Member, at int64) *Resolver {
	return &Resolver{ctx: ctx, db: db, actor: actor, at: at}
}

// Project finds a project by its key or id.
func (r *Resolver) Project(ref string) (core.Project, error) { return r.project(ref) }

// Task finds a task by its key (SVA-12) or id, in the trash or not.
func (r *Resolver) Task(ref string) (core.Task, error) { return r.anyTask("task", ref) }

// Member finds a member by id, @handle or "me"; field names the argument in
// a refusal.
func (r *Resolver) Member(field, ref string) (core.Member, error) { return r.memberRef(field, ref) }

// Cycle finds a cycle of the project by id, number, "current" or "next".
func (r *Resolver) Cycle(project core.Project, ref string) (core.Cycle, error) {
	return r.cycle(project, "cycle", ref)
}

var taskKeyRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{1,9}-\d+$`)

func isID(s string) bool { return len(s) == 36 && id.Valid(s) }

// project finds a live project by key or id, naming the keys there are when
// it finds none.
func (r *Resolver) project(ref string) (core.Project, error) {
	var project core.Project
	if ref == "" {
		return project, invalid("project", "a project is required: give its key (SVA) or id")
	}
	cond := store.Eq("key", strings.ToUpper(ref))
	if isID(ref) {
		cond = store.Eq("id", ref)
	}
	there, err := store.Find(r.ctx, r.db, &project, cond, store.Live)
	if err != nil {
		return project, err
	}
	if !there {
		var all []core.Project
		if err := r.db.List(r.ctx, &all, store.Q{Where: []store.Cond{store.Live}, Order: "key"}); err != nil {
			return project, err
		}
		keys := make([]string, len(all))
		for i, x := range all {
			keys[i] = x.Key
		}
		e := notFound("project", ref)
		e.Field, e.Allowed, e.Nearest = "project", keys, nearest(strings.ToUpper(ref), keys)
		return project, e
	}
	return project, nil
}

// anyTask loads a task by id or key, in the trash or not.
func (r *Resolver) anyTask(field, ref string) (core.Task, error) {
	var t core.Task
	if ref == "" {
		return t, invalid(field, "a task is required: give its key (SVA-12) or id")
	}
	var cond store.Cond
	switch {
	case isID(ref):
		cond = store.Eq("id", ref)
	case taskKeyRE.MatchString(ref):
		cond = store.Eq("key", strings.ToUpper(ref))
	default:
		return t, invalid(field, "%q is not a task: use its key (SVA-12) or id", ref)
	}
	there, err := store.Find(r.ctx, r.db, &t, cond)
	if err != nil {
		return t, err
	}
	if !there && !isID(ref) {
		// The key it had before it moved to another project still finds it.
		var was core.TaskKey
		ok, err := store.Find(r.ctx, r.db, &was, store.Eq("key", strings.ToUpper(ref)))
		if err != nil {
			return t, err
		}
		if ok {
			if there, err = store.Find(r.ctx, r.db, &t, store.Eq("id", was.TaskID)); err != nil {
				return t, err
			}
		}
	}
	if !there {
		e := notFound("task", ref)
		e.Field = field
		return t, e
	}
	return t, nil
}

// task loads a task that is not in the trash.
func (r *Resolver) task(field, ref string) (core.Task, error) {
	t, err := r.anyTask(field, ref)
	if err != nil {
		return t, err
	}
	if t.DeletedAt != 0 {
		return t, conflictErr("task %s is in the trash; restore it first", t.Key)
	}
	return t, nil
}

// memberRef finds a member by id, @handle, or "me".
func (r *Resolver) memberRef(field, ref string) (core.Member, error) {
	if ref == "me" {
		return r.actor, nil
	}
	var m core.Member
	cond := store.Eq("handle", strings.ToLower(strings.TrimPrefix(ref, "@")))
	if isID(ref) {
		cond = store.Eq("user_id", ref)
	}
	there, err := store.Find(r.ctx, r.db, &m, cond, store.Null("removed_at"))
	if err != nil {
		return m, err
	}
	if !there {
		var all []core.Member
		if err := r.db.List(r.ctx, &all, store.Q{Where: []store.Cond{store.Null("removed_at")}, Order: "handle"}); err != nil {
			return m, err
		}
		handles := make([]string, len(all))
		for i, x := range all {
			handles[i] = "@" + x.Handle
		}
		e := notFound("member", ref)
		e.Field, e.Allowed, e.Nearest = field, handles, nearest("@"+strings.TrimPrefix(ref, "@"), handles)
		return m, e
	}
	return m, nil
}

// optMember resolves an optional member reference to a user id; "" stays "".
func (r *Resolver) optMember(field, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	m, err := r.memberRef(field, ref)
	return m.UserID, err
}

func (r *Resolver) statuses(projectID string) ([]core.Status, error) {
	var all []core.Status
	err := r.db.List(r.ctx, &all, store.Q{Where: []store.Cond{store.Eq("project_id", projectID), store.Live}, Order: "rank"})
	return all, err
}

// status finds a status of the project by id, by name, or by category (the
// first status of that category).
func (r *Resolver) status(project core.Project, field, ref string) (core.Status, error) {
	all, err := r.statuses(project.ID)
	if err != nil {
		return core.Status{}, err
	}
	low := strings.ToLower(strings.TrimSpace(ref))
	for _, s := range all {
		if s.ID == ref || strings.ToLower(s.Name) == low {
			return s, nil
		}
	}
	for _, s := range all {
		if s.Category == low {
			return s, nil
		}
	}
	names := make([]string, len(all))
	for i, s := range all {
		names[i] = s.Name
	}
	return core.Status{}, &Error{Code: CodeInvalid, Field: field, Message: "project " + project.Key + " has no status " + strconv.Quote(ref),
		Allowed: names, Nearest: nearest(ref, names)}
}

// defaultStatus is the status a new task in the project takes.
func (r *Resolver) defaultStatus(project core.Project) (core.Status, error) {
	all, err := r.statuses(project.ID)
	if err != nil {
		return core.Status{}, err
	}
	for _, s := range all {
		if s.IsDefault {
			return s, nil
		}
	}
	for _, s := range all {
		if s.Category == core.CatUnstarted || s.Category == core.CatBacklog {
			return s, nil
		}
	}
	if len(all) > 0 {
		return all[0], nil
	}
	return core.Status{}, conflictErr("project %s has no statuses", project.Key)
}

// label finds a label usable in the project (its own, or one shared by the
// workspace) by id or name.
func (r *Resolver) label(project core.Project, field, ref string) (core.Label, error) {
	var all []core.Label
	if err := r.db.List(r.ctx, &all, store.Q{Where: []store.Cond{store.Live}, Order: "name"}); err != nil {
		return core.Label{}, err
	}
	low := strings.ToLower(strings.TrimSpace(ref))
	var names []string
	for _, l := range all {
		if l.ProjectID != "" && l.ProjectID != project.ID {
			continue
		}
		if l.ID == ref || strings.ToLower(l.Name) == low {
			return l, nil
		}
		names = append(names, l.Name)
	}
	return core.Label{}, &Error{Code: CodeInvalid, Field: field, Message: "no label " + strconv.Quote(ref) + " in project " + project.Key,
		Allowed: names, Nearest: nearest(ref, names)}
}

func (r *Resolver) labelIDs(project core.Project, field string, refs []string) ([]string, error) {
	var out []string
	for _, ref := range refs {
		l, err := r.label(project, field, ref)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(out, l.ID) {
			out = append(out, l.ID)
		}
	}
	return out, nil
}

// epic finds an epic of the project by id or name.
func (r *Resolver) epic(project core.Project, field, ref string) (core.Epic, error) {
	var all []core.Epic
	if err := r.db.List(r.ctx, &all, store.Q{Where: []store.Cond{store.Eq("project_id", project.ID), store.Live}, Order: "rank"}); err != nil {
		return core.Epic{}, err
	}
	low := strings.ToLower(strings.TrimSpace(ref))
	names := make([]string, len(all))
	for i, e := range all {
		if e.ID == ref || strings.ToLower(e.Name) == low {
			return e, nil
		}
		names[i] = e.Name
	}
	return core.Epic{}, &Error{Code: CodeInvalid, Field: field, Message: "no epic " + strconv.Quote(ref) + " in project " + project.Key,
		Allowed: names, Nearest: nearest(ref, names)}
}

// cycle finds a cycle of the project by id, number, "current" or "next".
func (r *Resolver) cycle(project core.Project, field, ref string) (core.Cycle, error) {
	var all []core.Cycle
	if err := r.db.List(r.ctx, &all, store.Q{Where: []store.Cond{store.Eq("project_id", project.ID), store.Live}, Order: "starts_on"}); err != nil {
		return core.Cycle{}, err
	}
	today := time.UnixMilli(r.at).UTC().Format("2006-01-02")
	n, err := strconv.Atoi(strings.TrimPrefix(ref, "#"))
	if err != nil {
		n = 0 // not a number: an id, "current" or "next"
	}
	for _, cy := range all {
		switch {
		case cy.ID == ref, n > 0 && cy.Number == n:
			return cy, nil
		case ref == "current" && cy.StartsOn <= today && today <= cy.EndsOn:
			return cy, nil
		case ref == "next" && cy.StartsOn > today:
			return cy, nil
		}
	}
	return core.Cycle{}, &Error{Code: CodeInvalid, Field: field, Message: "no cycle " + strconv.Quote(ref) + " in project " + project.Key +
		": use its number, \"current\" or \"next\""}
}

// loadLive loads a live row by id, naming what is missing when it is.
func loadLive[T any](c *cx, what, field, ref string) (T, error) {
	var row T
	if ref == "" {
		return row, invalid(field, "%s is required", field)
	}
	conds := []store.Cond{store.Eq("id", ref)}
	if _, ok := reflect.TypeFor[T]().FieldByName("DeletedAt"); ok {
		conds = append(conds, store.Live)
	}
	if !looksLikeID(ref) {
		return byName[T](c, what, field, ref)
	}
	there, err := store.Find(c.ctx, c.tx, &row, conds...)
	if err != nil {
		return row, err
	}
	if !there {
		e := notFound(what, ref)
		e.Field = field
		return row, e
	}
	return row, nil
}

// looksLikeID reports whether a reference has the shape of an id.
func looksLikeID(ref string) bool {
	return len(ref) == 36 && ref[8] == '-' && ref[13] == '-' && ref[18] == '-' && ref[23] == '-'
}

// byName finds a row by what it is called: its slug, its name or its title.
// Names are not ids: when two rows share one the caller is told to use the
// id, and when none matches, which names there are.
func byName[T any](c *cx, what, field, ref string) (T, error) {
	var row T
	t := reflect.TypeFor[T]()
	var rows []T
	q := store.Q{Limit: 2000}
	if _, ok := t.FieldByName("DeletedAt"); ok {
		q.Where = append(q.Where, store.Live)
	}
	if err := c.tx.List(c.ctx, &rows, q); err != nil {
		return row, err
	}
	var hits []T
	var names []string
	for _, r := range rows {
		v := reflect.ValueOf(r)
		matched := false
		for _, f := range []string{"Slug", "Name", "Title"} {
			fv := v.FieldByName(f)
			if !fv.IsValid() || fv.Kind() != reflect.String || fv.String() == "" {
				continue
			}
			names = append(names, fv.String())
			if strings.EqualFold(fv.String(), ref) {
				matched = true
			}
		}
		if matched {
			hits = append(hits, r)
		}
	}
	switch len(hits) {
	case 1:
		return hits[0], nil
	case 0:
		e := notFound(what, ref)
		e.Field = field
		if len(names) <= 50 {
			e.Allowed = names
		}
		e.Nearest = nearest(ref, names)
		return row, e
	}
	return row, &Error{Code: CodeInvalid, Field: field, Message: fmt.Sprintf("%d %ss are called %q; use the id of the one you mean", len(hits), what, ref)}
}

func checkDate(field, s string) error {
	if s == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return invalid(field, "%q is not a date: use YYYY-MM-DD", s)
	}
	return nil
}

// jsonFields lists the JSON field names of the struct v points to.
func jsonFields(v any) []string {
	t := reflect.TypeOf(v)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var out []string
	for f := range t.Fields() {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

// nearest returns the allowed value closest to got, or "" if none is close.
func nearest(got string, allowed []string) string {
	got = strings.ToLower(got)
	best, bestD := "", 1<<30
	for _, a := range allowed {
		distance := editDistance(got, strings.ToLower(a))
		if distance < bestD {
			best, bestD = a, distance
		}
	}
	if bestD == 0 || bestD > max(2, len(got)/2) {
		return ""
	}
	return best
}

// editDistance is the Levenshtein distance between two strings, in runes.
func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}

// loadDoc loads a page the actor may see. A private page of someone else that
// was not shared with the actor does not exist as far as they can tell.
func (c *cx) loadDoc(field, ref string) (core.Doc, error) {
	d, err := loadLive[core.Doc](c, "doc", field, ref)
	if err != nil {
		return d, err
	}
	if !CanSeeDoc(d, c.actor.UserID) && !c.system {
		e := notFound("doc", ref)
		e.Field = field
		return d, e
	}
	return d, nil
}

// CanSeeDoc reports whether a member may see a page.
func CanSeeDoc(d core.Doc, userID string) bool {
	return d.OwnerID == "" || d.OwnerID == userID || slices.Contains(d.SharedWith, userID)
}
