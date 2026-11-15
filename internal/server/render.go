// The compact forms of tasks, decisions, comments and feed events: the
// views a read answers with, and their lines of text.

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// The compact forms below are what agents read: names instead of ids, one
// line per thing in text form, and long text cut at a stated size.

// priorityNames names the priorities by number; 0 is none.
var priorityNames = []string{"", "urgent", "high", "medium", "low"}

// taskView is a task the way it is listed.
type taskView struct {
	Key           string   `json:"key"`
	Title         string   `json:"title"`
	Status        string   `json:"status"`
	Category      string   `json:"category,omitempty"`
	Priority      string   `json:"priority,omitempty"`
	Assignee      string   `json:"assignee,omitempty"`
	WaitingOn     string   `json:"waiting_on,omitempty"`
	WaitingOnNote string   `json:"waiting_on_note,omitempty"`
	HeldBy        string   `json:"held_by,omitempty"`
	Labels        []string `json:"labels,omitempty"`
	Epic          string   `json:"epic,omitempty"`
	Milestone     string   `json:"milestone,omitempty"`
	// Budget is the task's own limit; Spent what agents have used of it.
	Budget      *core.Budget `json:"budget,omitempty"`
	Spent       *core.Budget `json:"spent,omitempty"`
	Cycle       int          `json:"cycle,omitempty"`
	Parent      string       `json:"parent,omitempty"`
	DueOn       string       `json:"due_on,omitempty"`
	Estimate    int          `json:"estimate,omitempty"`
	Project     string       `json:"project,omitempty"`
	Description string       `json:"description,omitempty"`
	Truncated   bool         `json:"description_truncated,omitempty"`
	ID          string       `json:"id,omitempty"`
	CreatedBy   string       `json:"created_by,omitempty"`
	CreatedAt   string       `json:"created_at,omitempty"`
	Seq         int64        `json:"seq"`         // moves on anything in the task
	UpdatedSeq  int64        `json:"updated_seq"` // moves when its own fields change
	Trashed     bool         `json:"trashed,omitempty"`
	Archived    bool         `json:"archived,omitempty"`
}

// formatTime is a moment as the compact forms show it, in UTC to the
// minute; "" for none.
func formatTime(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02 15:04")
}

// truncate shortens text to limit bytes on a rune boundary, and says
// whether it did. A limit of 0 or less keeps it whole.
func truncate(s string, limit int) (string, bool) {
	if limit <= 0 || len(s) <= limit {
		return s, false
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit], true
}

// oneLine is text on one line, its runs of white space made one space, cut
// at limit bytes with "…" when it was longer.
func oneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if out, was := truncate(s, limit); was {
		return out + "…"
	}
	return s
}

// taskViews turns tasks into their listed form.
func (who *viewer) taskViews(ctx context.Context, tasks []core.Task) ([]taskView, error) {
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	// Parents are named by key, which takes one more read for all of them.
	var parentIDs []string
	for _, t := range tasks {
		if t.ParentID != "" {
			parentIDs = append(parentIDs, t.ParentID)
		}
	}
	parentKey := map[string]string{}
	if len(parentIDs) > 0 {
		parents, err := who.db.Tasks(ctx, store.TaskFilter{IDs: parentIDs, Archived: true, Limit: maxTasksByID})
		if err != nil {
			return nil, err
		}
		for _, parent := range parents {
			parentKey[parent.ID] = parent.Key
		}
	}
	now := time.Now().UnixMilli()
	out := make([]taskView, len(tasks))
	for i, t := range tasks {
		status := names.statuses[t.StatusID]
		v := taskView{Key: t.Key, Title: t.Title, Status: status.Name, Category: status.Category, Assignee: names.handle(t.AssigneeID),
			WaitingOn: waitsOn(names, t), WaitingOnNote: t.WaitingOnNote, Labels: names.labelNames(t.LabelIDs),
			Epic: names.epics[t.EpicID].Name, Milestone: names.milestones[t.MilestoneID], Budget: t.Budget, Cycle: names.cycles[t.CycleID].Number, Parent: parentKey[t.ParentID], DueOn: t.DueOn,
			Estimate: t.Estimate, Seq: t.ActivitySeq, UpdatedSeq: t.UpdatedSeq, Trashed: t.DeletedAt != 0, Archived: t.ArchivedAt != 0}
		if t.Priority > 0 && t.Priority < len(priorityNames) {
			v.Priority = priorityNames[t.Priority]
		}
		if t.LeaseHolderID != "" && t.LeaseUntil > now {
			v.HeldBy = names.handle(t.LeaseHolderID)
		}
		out[i] = v
	}
	return out, nil
}

// detailedTaskViews turns tasks into their listed form with the fields a
// list leaves out: the id, the project, the description, and who made the
// task and when.
func (who *viewer) detailedTaskViews(ctx context.Context, tasks []core.Task) ([]taskView, error) {
	views, err := who.taskViews(ctx, tasks)
	if err != nil {
		return nil, err
	}
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	for i, t := range tasks {
		views[i].ID, views[i].Project, views[i].Description = t.ID, names.projects[t.ProjectID].Key, t.Description
		views[i].CreatedBy, views[i].CreatedAt = names.handle(t.CreatedBy), formatTime(t.CreatedAt)
	}
	return views, nil
}

// maxTasksByID is the most tasks one read by id brings: more than a
// request ever names.
const maxTasksByID = 5000

// pickFields keeps only the named fields of each item, for callers that asked.
func pickFields(items any, fields []string) any {
	if len(fields) == 0 {
		return items
	}
	raw := plainjson.Marshal(items)
	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil {
		return items
	}
	for i, row := range rows {
		kept := map[string]any{}
		for _, f := range fields {
			if v, ok := row[f]; ok {
				kept[f] = v
			}
		}
		rows[i] = kept
	}
	return rows
}

// line renders a task on one line.
func (v taskView) line() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s  [%s]", v.Key, v.Status)
	if v.Archived {
		b.WriteString("  (archived)")
	}
	if v.Priority != "" {
		b.WriteString("  !" + v.Priority)
	}
	if v.Assignee != "" {
		b.WriteString("  " + v.Assignee)
	}
	if v.WaitingOn != "" {
		b.WriteString("  waits on " + v.WaitingOn)
		if v.WaitingOn == "outside" {
			b.WriteString(" (" + oneLine(v.WaitingOnNote, 60) + ")")
		}
	}
	if v.HeldBy != "" && v.HeldBy != v.Assignee {
		b.WriteString("  held by " + v.HeldBy)
	}
	b.WriteString("  " + v.Title)
	for _, l := range v.Labels {
		b.WriteString("  #" + l)
	}
	if v.DueOn != "" {
		b.WriteString("  due " + v.DueOn)
	}
	if v.Parent != "" {
		b.WriteString("  in " + v.Parent)
	}
	return b.String()
}

// attachmentView is a file as it is shown on a task, a comment or a decision.
type attachmentView struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	URL     string `json:"url"`
	Preview string `json:"preview,omitempty"` // a reduced copy, cheap to look at
	Role    string `json:"role,omitempty"`
	Caption string `json:"caption,omitempty"`
}

// optionView is one option of a decision, numbered from 1.
type optionView struct {
	N           int              `json:"n"`
	ID          string           `json:"id"`
	Label       string           `json:"label"`
	Description string           `json:"description,omitempty"`
	Attachments []attachmentView `json:"attachments,omitempty"`
	Comments    int              `json:"comments,omitempty"`
}

// decisionView is a decision the way it is shown: numbered within its task,
// people by handle, its options with theirs.
type decisionView struct {
	N         int    `json:"n"`
	ID        string `json:"id"`
	Task      string `json:"task,omitempty"`
	TaskID    string `json:"task_id,omitempty"`
	DeletedAt int64  `json:"deleted_at,omitempty"`
	Kind      string `json:"kind"`
	Question  string `json:"question"`
	Details   string `json:"details,omitempty"`
	Action    string `json:"action,omitempty"`
	State     string `json:"state"`
	By        string `json:"by"`
	Asked     string `json:"asked,omitempty"`
	// Files on the question itself, shown with it before the options.
	Attachments    []attachmentView `json:"attachments,omitempty"`
	Options        []optionView     `json:"options,omitempty"`
	Recommended    int              `json:"recommended,omitempty"`
	Recommendation string           `json:"recommendation,omitempty"`
	Picked         int              `json:"picked,omitempty"`
	PickedLabel    string           `json:"picked_label,omitempty"`
	Outcome        string           `json:"outcome,omitempty"`
	Note           string           `json:"note,omitempty"`
	DecidedBy      string           `json:"decided_by,omitempty"`
	DecidedAt      string           `json:"decided_at,omitempty"`
	UnclearNote    string           `json:"unclear_note,omitempty"`
	AskedAt        string           `json:"asked_at,omitempty"`
}

// fileLine is a file of a decision in text: its name and address.
func fileLine(a attachmentView) string { return "file: " + a.Name + " " + a.URL }

// text is the decision as lines: the question, each option with its marks
// (recommended, picked), and the answer.
func (d decisionView) text() string {
	var b strings.Builder
	head := fmt.Sprintf("--- decision %d (%s", d.N, d.State)
	if d.Asked != "" {
		head += ", asked " + d.Asked
	}
	fmt.Fprintf(&b, "%s by %s) id=%s\n%s\n", head, d.By, d.ID, d.Question)
	if d.Details != "" {
		b.WriteString(d.Details + "\n")
	}
	if d.Action != "" {
		b.WriteString("approval for: " + d.Action + "\n")
	}
	for _, a := range d.Attachments {
		b.WriteString(fileLine(a) + "\n")
	}
	for _, o := range d.Options {
		fmt.Fprintf(&b, "  %d) %s", o.N, o.Label)
		if o.Description != "" {
			b.WriteString(": " + oneLine(o.Description, 200))
		}
		if o.N == d.Recommended {
			b.WriteString("   <- recommended")
			if d.Recommendation != "" {
				b.WriteString(": " + oneLine(d.Recommendation, 200))
			}
		}
		if o.N == d.Picked {
			b.WriteString("   <- PICKED")
		}
		for _, a := range o.Attachments {
			b.WriteString("\n       " + fileLine(a))
		}
		b.WriteString("\n")
	}
	if d.Outcome != "" {
		fmt.Fprintf(&b, "answer: %s by %s at %s", d.Outcome, d.DecidedBy, d.DecidedAt)
		if d.Note != "" {
			b.WriteString(": " + d.Note)
		}
		b.WriteString("\n")
	}
	if d.UnclearNote != "" {
		b.WriteString("unclear: " + d.UnclearNote + "\n")
	}
	return b.String()
}

// commentView is a comment the way it is shown on its task.
type commentView struct {
	ID          string           `json:"id"`
	Seq         int64            `json:"seq"`
	By          string           `json:"by"`
	At          string           `json:"at"`
	Kind        string           `json:"kind,omitempty"`
	On          string           `json:"on,omitempty"` // "decision 1", "option 2 of decision 1"
	ReplyTo     string           `json:"reply_to,omitempty"`
	Body        string           `json:"body"`
	Truncated   bool             `json:"truncated,omitempty"`
	Evidence    *core.Evidence   `json:"evidence,omitempty"`
	Attachments []attachmentView `json:"attachments,omitempty"`
	Edited      bool             `json:"edited,omitempty"`
}

// text is the comment on one line, with its evidence and files below it.
func (cm commentView) text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "[#%d %s %s]", cm.Seq, cm.By, cm.At)
	if cm.Kind == core.CommentResult {
		b.WriteString(" RESULT")
	}
	if cm.On != "" {
		b.WriteString(" on " + cm.On)
	}
	b.WriteString(": " + cm.Body)
	if cm.Truncated {
		b.WriteString("… (cut; add full=1)")
	}
	if e := cm.Evidence; e != nil {
		if e.Checked != "" {
			b.WriteString("\n    checked: " + e.Checked)
		}
		if e.Measured != "" {
			b.WriteString("\n    measured: " + e.Measured)
		}
		if e.NotVerified != "" {
			b.WriteString("\n    not verified: " + e.NotVerified)
		}
	}
	for _, a := range cm.Attachments {
		fmt.Fprintf(&b, "\n    file: %s %s", a.Name, a.URL)
	}
	return b.String()
}

// relationView is a task related to the one shown, from that one's side.
type relationView struct {
	ID    string `json:"id"`
	Type  string `json:"type"` // blocks, blocked_by, relates, duplicates, duplicated_by
	Task  string `json:"task"`
	Title string `json:"title"`
	State string `json:"status"`
}

// linkView is a link on a task: a branch, a pull request, a URL.
type linkView struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Ref    string `json:"ref,omitempty"`
	Repo   string `json:"repo,omitempty"`
	Title  string `json:"title,omitempty"`
	URL    string `json:"url,omitempty"`
	State  string `json:"state,omitempty"`
	Checks string `json:"checks,omitempty"`
	// Data is what the link carries besides: a branch's commits ahead of
	// the main branch, a pull request's numbers.
	Data json.RawMessage `json:"data,omitempty"`
}

// taskDetail is one task with everything in it, as GET /tasks/KEY gives it.
type taskDetail struct {
	Task        taskView         `json:"task"`
	Subtasks    []taskView       `json:"subtasks,omitempty"`
	Decisions   []decisionView   `json:"decisions,omitempty"`
	Comments    []commentView    `json:"comments,omitempty"`
	Relations   []relationView   `json:"relations,omitempty"`
	Links       []linkView       `json:"links,omitempty"`
	Attachments []attachmentView `json:"attachments,omitempty"`
	Watchers    []string         `json:"watchers,omitempty"`
	// Seq is the workspace's position when this was read: ask for
	// "since=Seq" later to get only what changed.
	Seq int64 `json:"seq"`
}

// text is the task in full as text, in this order: the title, a line of
// status and people, a line of everything else it has (labels, epic,
// budget, dates, the feed position), the description, files, sub-tasks,
// relations, links, decisions and comments.
func (d taskDetail) text() string {
	var b strings.Builder
	t := d.Task
	fmt.Fprintf(&b, "%s  %s\n", t.Key, t.Title)
	fmt.Fprintf(&b, "status: %s", t.Status)
	if t.Archived {
		b.WriteString(" (archived)")
	}
	if t.Trashed {
		b.WriteString(" (in the trash)")
	}
	if t.Priority != "" {
		b.WriteString("   priority: " + t.Priority)
	}
	if t.Assignee != "" {
		b.WriteString("   assignee: " + t.Assignee)
	}
	if t.WaitingOn != "" {
		b.WriteString("   waits on: " + t.WaitingOn)
		if t.WaitingOnNote != "" {
			b.WriteString(" (" + t.WaitingOnNote + ")")
		}
	}
	if t.HeldBy != "" {
		b.WriteString("   held by: " + t.HeldBy)
	}
	b.WriteString("\n")
	var meta []string
	if len(t.Labels) > 0 {
		meta = append(meta, "labels: "+strings.Join(t.Labels, ", "))
	}
	if t.Epic != "" {
		meta = append(meta, "epic: "+t.Epic)
	}
	if t.Milestone != "" {
		meta = append(meta, "milestone: "+t.Milestone)
	}
	if budget := t.Budget; budget != nil {
		var parts []string
		spent := core.Budget{}
		if t.Spent != nil {
			spent = *t.Spent
		}
		if budget.CostMicros > 0 {
			parts = append(parts, fmt.Sprintf("$%.2f of $%.2f", float64(spent.CostMicros)/1e6, float64(budget.CostMicros)/1e6))
		}
		if budget.Minutes > 0 {
			parts = append(parts, fmt.Sprintf("%d of %d min", spent.Minutes, budget.Minutes))
		}
		if budget.Handoffs > 0 {
			parts = append(parts, fmt.Sprintf("%d hand-offs at most", budget.Handoffs))
		}
		meta = append(meta, "budget: "+strings.Join(parts, ", "))
	}
	if t.Cycle != 0 {
		meta = append(meta, fmt.Sprintf("cycle: %d", t.Cycle))
	}
	if t.Parent != "" {
		meta = append(meta, "parent: "+t.Parent)
	}
	if t.DueOn != "" {
		meta = append(meta, "due: "+t.DueOn)
	}
	if t.Estimate != 0 {
		meta = append(meta, fmt.Sprintf("estimate: %d", t.Estimate))
	}
	meta = append(meta, fmt.Sprintf("seq: %d", d.Seq))
	b.WriteString(strings.Join(meta, "   ") + "\n")
	if t.Description != "" {
		b.WriteString("---\n" + t.Description)
		if t.Truncated {
			b.WriteString("… (cut; add full=1)")
		}
		b.WriteString("\n")
	}
	for _, a := range d.Attachments {
		fmt.Fprintf(&b, "file: %s %s\n", a.Name, a.URL)
	}
	if len(d.Subtasks) > 0 {
		b.WriteString("--- sub-tasks\n")
		for _, s := range d.Subtasks {
			b.WriteString(s.line() + "\n")
		}
	}
	for _, r := range d.Relations {
		fmt.Fprintf(&b, "%s %s [%s] %s\n", strings.ReplaceAll(r.Type, "_", " "), r.Task, r.State, r.Title)
	}
	for _, l := range d.Links {
		fmt.Fprintf(&b, "%s %s %s %s %s\n", l.Kind, l.Ref, l.State, l.Checks, l.URL)
	}
	for _, dv := range d.Decisions {
		b.WriteString(dv.text())
	}
	if len(d.Comments) > 0 {
		b.WriteString("--- comments\n")
		for _, cm := range d.Comments {
			b.WriteString(cm.text() + "\n")
		}
	}
	return b.String()
}

// eventLine says what one event did, on one line: its number, time and
// actor, then what happened in words. Tasks, comments, decisions, claims and
// inbox items each have their own wording; any other event says its type
// and its changed fields (changeText), or the name of what it made.
func (who *viewer) eventLine(ctx context.Context, ev core.Event, names *nameLookup) string {
	data, _ := ev.Payload() // like readStored: data that does not read makes a shorter line
	key := ""
	if data.Key != nil {
		key = *data.Key
	}
	head := fmt.Sprintf("#%d %s %s", ev.Seq, time.UnixMilli(ev.At).UTC().Format("01-02 15:04"), names.handle(ev.ActorID))
	what := ev.Type
	if key != "" {
		what += " " + key
	}
	switch ev.Type {
	case "task.created":
		var t core.Task
		data.ReadRow(&t)
		what = fmt.Sprintf("task.created %s %q [%s]", t.Key, t.Title, names.statuses[t.StatusID].Name)
		if t.AssigneeID != "" {
			what += " " + names.handle(t.AssigneeID)
		}
	case "task.updated":
		what += " " + names.changeText(data.Changes)
	case "comment.created":
		var cm core.Comment
		data.ReadRow(&cm)
		kind := "comment"
		if cm.Kind == core.CommentResult {
			kind = "RESULT"
		}
		on := ""
		switch cm.SubjectType {
		case "decision_option":
			on = " on an option"
		case "decision":
			on = " on a decision"
		}
		what = fmt.Sprintf("%s %s%s: %s  (id=%s)", kind, key, on, oneLine(cm.Body, 240), cm.ID)
	case "decision.opened", "decision.picked", "decision.unclear":
		var decision core.Decision
		data.ReadRow(&decision)
		what = fmt.Sprintf("%s %s %q", ev.Type, key, oneLine(decision.Question, 120))
		switch ev.Type {
		case "decision.opened":
			var opts []string
			for i, o := range decision.Options {
				mark := ""
				if o.ID == decision.RecommendedOptionID {
					mark = "*"
				}
				opts = append(opts, fmt.Sprintf("%d) %s%s", i+1, o.Label, mark))
			}
			if len(opts) > 0 {
				what += " [" + strings.Join(opts, "  ") + "]"
			}
			if decision.AskedID != "" {
				what += " asked " + names.handle(decision.AskedID)
			}
		case "decision.picked":
			ans := decision.Outcome
			for i, o := range decision.Options {
				if o.ID == decision.PickedOptionID {
					ans = fmt.Sprintf("%d) %s (%s)", i+1, o.Label, decision.Outcome)
				}
			}
			what += " -> " + ans
			if decision.OutcomeNote != "" {
				what += ": " + oneLine(decision.OutcomeNote, 240)
			}
		default:
			what += " unclear: " + oneLine(decision.UnclearNote, 240)
		}
		what += "  (id=" + decision.ID + ")"
	case "claim.created", "claim.updated":
		var claim core.ResourceClaim
		data.ReadRow(&claim)
		switch {
		case ev.Type == "claim.updated":
			// Whose hold on what: the one acting may be an admin, or the
			// server handing the resource to the next in line.
			what = "claim " + firstNonEmpty(data.Why, "changed")
			var resource core.Resource
			if data.ResourceID != "" && who.foundForLine(ctx, &resource, store.Eq("id", data.ResourceID)) {
				what += ": " + resource.Name
			}
			if data.UserID != "" {
				what += " (" + names.handle(data.UserID) + ")"
			}
			if data.TaskID != nil {
				claim.TaskID = *data.TaskID
			}
		case claim.State == core.ClaimHolding:
			what = "claim: took " + data.Resource
		default:
			what = "claim: waits for " + data.Resource
		}
		if claim.TaskID != "" {
			var t core.Task
			if who.foundForLine(ctx, &t, store.Eq("id", claim.TaskID)) {
				what += " for " + t.Key
			}
		}
		if claim.Note != "" {
			what += ": " + oneLine(claim.Note, 120)
		}
	case "notification.created":
		var note core.Notification
		data.ReadRow(&note)
		what = fmt.Sprintf("inbox %s: %s", note.Type, oneLine(note.Title, 100))
		if note.Snippet != "" {
			what += " — " + oneLine(note.Snippet, 160)
		}
	default:
		if ev.EntityType == "member" && ev.Type != "member.created" {
			what += " " + names.handle(ev.EntityID) // whose membership it is
		}
		if len(data.Changes) > 0 {
			what += " " + names.changeText(data.Changes)
		} else if row := map[string]any{}; key == "" && data.ReadRow(&row) {
			// Something new that the cases above do not know: its name.
			for _, k := range []string{"key", "name", "title", "slug", "handle", "repo", "body"} {
				if v, _ := row[k].(string); v != "" {
					what += " " + strconv.Quote(oneLine(v, 80))
					break
				}
			}
		}
	}
	return head + " " + what
}

// readStored decodes JSON the server itself wrote: an event's data, a row's
// properties, a property's config, a page's props or snapshot. What cannot
// be read is left at its zero value, and the reader shows less (an emptier
// feed line, empty cells, a page built again) rather than fail.
func readStored(raw []byte, dst any) {
	_ = json.Unmarshal(raw, dst) // deliberate, as said above
}

// foundForLine reads one row that a line of text names, if it can, and
// says whether it was found. The line is written without it otherwise; a
// read that failed is logged, since a line cannot report it.
func (who *viewer) foundForLine(ctx context.Context, dst any, where ...store.Cond) bool {
	there, err := store.Find(ctx, who.db, dst, where...)
	if err != nil {
		who.log.Warn("a feed line left out a name it could not read", "err", err)
	}
	return there
}

// quietFields say nothing a reader needs on a feed line.
var quietFields = map[string]bool{"started_at": true, "completed_at": true, "canceled_at": true, "lease_until": true, "rank": true,
	"number": true, "deleted_at": true, "archived_at": true, "updated_at": true, "content_seq": true, "updated_by": true,
	"removed_at": true, "suspended_at": true}

// changeText says in words what an update changed, field by field in
// alphabetical order: "status: Todo -> Done; assignee: none -> @ann". Ids
// become names, quiet fields are left out, and the moves into and out of
// the trash, the archive, removal and suspension are said as one word.
func (n *nameLookup) changeText(changes map[string]core.FieldChange) string {
	var parts []string
	// name says one value of a field: what the id names, or the value itself.
	name := func(field string, v any) string {
		s, _ := v.(string)
		switch field {
		case "status_id":
			return n.statuses[s].Name
		case "assignee_id", "waiting_on_id", "lease_holder_id", "lead_id":
			return n.handle(s)
		case "epic_id":
			return n.epics[s].Name
		case "cycle_id":
			if cycle, ok := n.cycles[s]; ok {
				return fmt.Sprintf("%d", cycle.Number)
			}
			return ""
		case "label_ids":
			list, _ := v.([]any)
			var ids []string
			for _, l := range list {
				if id, ok := l.(string); ok {
					ids = append(ids, id)
				}
			}
			return strings.Join(n.labelNames(ids), ",")
		case "priority":
			if f, ok := v.(float64); ok && int(f) < len(priorityNames) {
				return priorityNames[int(f)]
			}
		case "description", "body":
			return oneLine(s, 80)
		}
		if v == nil {
			return ""
		}
		if s != "" {
			return oneLine(s, 80)
		}
		switch t := v.(type) {
		case map[string]any:
			// A budget or a set of limits: its parts in words, not as Go prints a map.
			if len(t) == 0 {
				return ""
			}
			var parts []string
			for k, val := range t {
				switch k {
				case "cost_micros":
					if n, ok := val.(float64); ok {
						parts = append(parts, "cost "+formatMoney(int64(n)))
						continue
					}
				case "projects":
					if ids, ok := val.([]any); ok {
						var keys []string
						for _, id := range ids {
							pid, _ := id.(string)
							keys = append(keys, firstNonEmpty(n.projects[pid].Key, pid))
						}
						parts = append(parts, "projects "+strings.Join(keys, ","))
						continue
					}
				}
				raw := plainjson.Marshal(val)
				parts = append(parts, strings.ReplaceAll(k, "_", " ")+" "+strings.Trim(string(raw), `"`))
			}
			sort.Strings(parts)
			return oneLine(strings.Join(parts, "; "), 300)
		case []any:
			raw := plainjson.Marshal(t)
			return oneLine(string(raw), 80)
		case float64:
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
		return fmt.Sprint(v)
	}
	for _, f := range slices.Sorted(maps.Keys(changes)) {
		ch := changes[f]
		if quietFields[f] {
			if f == "deleted_at" {
				if ch.To != nil && ch.To != float64(0) {
					parts = append(parts, "moved to trash")
				} else {
					parts = append(parts, "restored")
				}
			}
			if f == "removed_at" || f == "suspended_at" {
				word := map[string][2]string{"removed_at": {"removed", "brought back"}, "suspended_at": {"suspended", "no longer suspended"}}[f]
				if ch.To != nil && ch.To != float64(0) {
					parts = append(parts, word[0])
				} else {
					parts = append(parts, word[1])
				}
			}
			if f == "archived_at" {
				if ch.To != nil && ch.To != float64(0) {
					parts = append(parts, "archived")
				} else {
					parts = append(parts, "taken out of the archive")
				}
			}
			continue
		}
		from, to := name(f, ch.From), name(f, ch.To)
		if from == "" {
			from = "none"
		}
		if to == "" {
			to = "none"
		}
		parts = append(parts, fmt.Sprintf("%s: %s -> %s", strings.TrimSuffix(strings.TrimSuffix(f, "_id"), "_ids"), from, to))
	}
	return strings.Join(parts, "; ")
}

// waitsOn names who has the next move on a task: a member's handle, or
// "outside" when it waits for an event its note describes.
func waitsOn(names *nameLookup, t core.Task) string {
	if t.WaitingOutside {
		return "outside"
	}
	return names.handle(t.WaitingOnID)
}
