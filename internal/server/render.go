package server

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// The compact forms below are what agents read: names instead of ids, one
// line per thing in text form, and long text cut at a stated size.

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

func when(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02 15:04")
}

// cut shortens text to max bytes on a rune boundary.
func cut(s string, max int) (string, bool) {
	if max <= 0 || len(s) <= max {
		return s, false
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max], true
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if out, was := cut(s, max); was {
		return out + "…"
	}
	return s
}

// taskViews turns tasks into their listed form. detail adds the fields a
// list leaves out.
func (x *c) taskViews(tasks []core.Task, detail bool) ([]taskView, error) {
	nm, err := x.names()
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
		ps, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: parentIDs, Archived: true, Limit: 5000})
		if err != nil {
			return nil, err
		}
		for _, p := range ps {
			parentKey[p.ID] = p.Key
		}
	}
	now := time.Now().UnixMilli()
	out := make([]taskView, len(tasks))
	for i, t := range tasks {
		st := nm.statuses[t.StatusID]
		v := taskView{Key: t.Key, Title: t.Title, Status: st.Name, Category: st.Category, Assignee: nm.handle(t.AssigneeID),
			WaitingOn: waitsOn(nm, t), WaitingOnNote: t.WaitingOnNote, Labels: nm.labelNames(t.LabelIDs),
			Epic: nm.epics[t.EpicID].Name, Milestone: nm.milestones[t.MilestoneID], Budget: t.Budget, Cycle: nm.cycles[t.CycleID].Number, Parent: parentKey[t.ParentID], DueOn: t.DueOn,
			Estimate: t.Estimate, Seq: t.ActivitySeq, UpdatedSeq: t.UpdatedSeq, Trashed: t.DeletedAt != 0, Archived: t.ArchivedAt != 0}
		if t.Priority > 0 && t.Priority < len(priorityNames) {
			v.Priority = priorityNames[t.Priority]
		}
		if t.LeaseHolderID != "" && t.LeaseUntil > now {
			v.HeldBy = nm.handle(t.LeaseHolderID)
		}
		if detail {
			v.ID, v.Project, v.Description = t.ID, nm.projects[t.ProjectID].Key, t.Description
			v.CreatedBy, v.CreatedAt = nm.handle(t.CreatedBy), when(t.CreatedAt)
		}
		out[i] = v
	}
	return out, nil
}

// pick keeps only the named fields of each item, for callers that asked.
func pick(items any, fields []string) any {
	if len(fields) == 0 {
		return items
	}
	raw, _ := json.Marshal(items)
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

type optionView struct {
	N           int              `json:"n"`
	ID          string           `json:"id"`
	Label       string           `json:"label"`
	Description string           `json:"description,omitempty"`
	Attachments []attachmentView `json:"attachments,omitempty"`
	Comments    int              `json:"comments,omitempty"`
}

type decisionView struct {
	N              int          `json:"n"`
	ID             string       `json:"id"`
	Task           string       `json:"task,omitempty"`
	TaskID         string       `json:"task_id,omitempty"`
	DeletedAt      int64        `json:"deleted_at,omitempty"`
	Kind           string       `json:"kind"`
	Question       string       `json:"question"`
	Details        string       `json:"details,omitempty"`
	Action         string       `json:"action,omitempty"`
	State          string       `json:"state"`
	By             string       `json:"by"`
	Asked          string       `json:"asked,omitempty"`
	Options        []optionView `json:"options,omitempty"`
	Recommended    int          `json:"recommended,omitempty"`
	Recommendation string       `json:"recommendation,omitempty"`
	Picked         int          `json:"picked,omitempty"`
	PickedLabel    string       `json:"picked_label,omitempty"`
	Outcome        string       `json:"outcome,omitempty"`
	Note           string       `json:"note,omitempty"`
	DecidedBy      string       `json:"decided_by,omitempty"`
	DecidedAt      string       `json:"decided_at,omitempty"`
	UnclearNote    string       `json:"unclear_note,omitempty"`
	AskedAt        string       `json:"asked_at,omitempty"`
}

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
			fmt.Fprintf(&b, "\n       file: %s %s", a.Name, a.URL)
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

func (cm commentView) text() string {
	var b strings.Builder
	fmt.Fprintf(&b, "[#%d %s %s]", cm.Seq, cm.By, cm.At)
	if cm.Kind == "result" {
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

type relationView struct {
	ID    string `json:"id"`
	Type  string `json:"type"` // blocks, blocked_by, relates, duplicates, duplicated_by
	Task  string `json:"task"`
	Title string `json:"title"`
	State string `json:"status"`
}

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
	if b := t.Budget; b != nil {
		var parts []string
		spent := core.Budget{}
		if t.Spent != nil {
			spent = *t.Spent
		}
		if b.CostMicros > 0 {
			parts = append(parts, fmt.Sprintf("$%.2f of $%.2f", float64(spent.CostMicros)/1e6, float64(b.CostMicros)/1e6))
		}
		if b.Minutes > 0 {
			parts = append(parts, fmt.Sprintf("%d of %d min", spent.Minutes, b.Minutes))
		}
		if b.Handoffs > 0 {
			parts = append(parts, fmt.Sprintf("%d hand-offs at most", b.Handoffs))
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

// eventLine says what one event did, on one line.
func (x *c) eventLine(ev core.Event, nm *names) string {
	var d struct {
		Key     string                      `json:"key"`
		Row     json.RawMessage             `json:"row"`
		Changes map[string]core.FieldChange `json:"changes"`
		Deleted bool                        `json:"deleted"`
	}
	json.Unmarshal(ev.Data, &d)
	head := fmt.Sprintf("#%d %s %s", ev.Seq, time.UnixMilli(ev.At).UTC().Format("01-02 15:04"), nm.handle(ev.ActorID))
	what := ev.Type
	if d.Key != "" {
		what += " " + d.Key
	}
	switch ev.Type {
	case "task.created":
		var t core.Task
		json.Unmarshal(d.Row, &t)
		what = fmt.Sprintf("task.created %s %q [%s]", t.Key, t.Title, nm.statuses[t.StatusID].Name)
		if t.AssigneeID != "" {
			what += " " + nm.handle(t.AssigneeID)
		}
	case "task.updated":
		what += " " + x.changeText(d.Changes, nm)
	case "comment.created":
		var cm core.Comment
		json.Unmarshal(d.Row, &cm)
		kind := "comment"
		if cm.Kind == "result" {
			kind = "RESULT"
		}
		on := ""
		if cm.SubjectType == "decision_option" {
			on = " on an option"
		} else if cm.SubjectType == "decision" {
			on = " on a decision"
		}
		what = fmt.Sprintf("%s %s%s: %s  (id=%s)", kind, d.Key, on, oneLine(cm.Body, 240), cm.ID)
	case "decision.opened", "decision.picked", "decision.unclear":
		var dc core.Decision
		json.Unmarshal(d.Row, &dc)
		what = fmt.Sprintf("%s %s %q", ev.Type, d.Key, oneLine(dc.Question, 120))
		switch ev.Type {
		case "decision.opened":
			var opts []string
			for i, o := range dc.Options {
				mark := ""
				if o.ID == dc.RecommendedOptionID {
					mark = "*"
				}
				opts = append(opts, fmt.Sprintf("%d) %s%s", i+1, o.Label, mark))
			}
			if len(opts) > 0 {
				what += " [" + strings.Join(opts, "  ") + "]"
			}
			if dc.AskedID != "" {
				what += " asked " + nm.handle(dc.AskedID)
			}
		case "decision.picked":
			ans := dc.Outcome
			for i, o := range dc.Options {
				if o.ID == dc.PickedOptionID {
					ans = fmt.Sprintf("%d) %s (%s)", i+1, o.Label, dc.Outcome)
				}
			}
			what += " -> " + ans
			if dc.OutcomeNote != "" {
				what += ": " + oneLine(dc.OutcomeNote, 240)
			}
		default:
			what += " unclear: " + oneLine(dc.UnclearNote, 240)
		}
		what += "  (id=" + dc.ID + ")"
	case "claim.created", "claim.updated":
		var cd struct {
			Row        core.ResourceClaim `json:"row"`
			Resource   string             `json:"resource"`
			Why        string             `json:"why"`
			ResourceID string             `json:"resource_id"`
			UserID     string             `json:"user_id"`
			TaskID     string             `json:"task_id"`
		}
		json.Unmarshal(ev.Data, &cd)
		switch {
		case ev.Type == "claim.updated":
			// Whose hold on what: the one acting may be an admin, or the
			// server handing the resource to the next in line.
			what = "claim " + orText(cd.Why, "changed")
			var res core.Resource
			if cd.ResourceID != "" && x.db.Get(x.ctx(), &res, store.Eq("id", cd.ResourceID)) == nil {
				what += ": " + res.Name
			}
			if cd.UserID != "" {
				what += " (" + nm.handle(cd.UserID) + ")"
			}
			cd.Row.TaskID = cd.TaskID
		case cd.Row.State == "holding":
			what = "claim: took " + cd.Resource
		default:
			what = "claim: waits for " + cd.Resource
		}
		if cd.Row.TaskID != "" {
			var tk core.Task
			if x.db.Get(x.ctx(), &tk, store.Eq("id", cd.Row.TaskID)) == nil {
				what += " for " + tk.Key
			}
		}
		if cd.Row.Note != "" {
			what += ": " + oneLine(cd.Row.Note, 120)
		}
	case "notification.created":
		var n core.Notification
		json.Unmarshal(d.Row, &n)
		what = fmt.Sprintf("inbox %s: %s", n.Type, oneLine(n.Title, 100))
		if n.Snippet != "" {
			what += " — " + oneLine(n.Snippet, 160)
		}
	default:
		if ev.EntityType == "member" && ev.Type != "member.created" {
			what += " " + nm.handle(ev.EntityID) // whose membership it is
		}
		if len(d.Changes) > 0 {
			what += " " + x.changeText(d.Changes, nm)
		} else if d.Key == "" && len(d.Row) > 0 {
			// Something new that the cases above do not know: its name.
			var row map[string]any
			json.Unmarshal(d.Row, &row)
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

// quiet fields say nothing a reader needs on a feed line.
var quietFields = map[string]bool{"started_at": true, "completed_at": true, "canceled_at": true, "lease_until": true, "rank": true,
	"number": true, "deleted_at": true, "archived_at": true, "updated_at": true}

func (x *c) changeText(changes map[string]core.FieldChange, nm *names) string {
	var parts []string
	name := func(field string, v any) string {
		s, _ := v.(string)
		switch field {
		case "status_id":
			return nm.statuses[s].Name
		case "assignee_id", "waiting_on_id", "lease_holder_id", "lead_id":
			return nm.handle(s)
		case "epic_id":
			return nm.epics[s].Name
		case "cycle_id":
			if c, ok := nm.cycles[s]; ok {
				return fmt.Sprintf("%d", c.Number)
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
			return strings.Join(nm.labelNames(ids), ",")
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
						parts = append(parts, "cost "+money(int64(n)))
						continue
					}
				case "projects":
					if ids, ok := val.([]any); ok {
						var keys []string
						for _, id := range ids {
							pid, _ := id.(string)
							keys = append(keys, orText(nm.projects[pid].Key, pid))
						}
						parts = append(parts, "projects "+strings.Join(keys, ","))
						continue
					}
				}
				raw, _ := json.Marshal(val)
				parts = append(parts, strings.ReplaceAll(k, "_", " ")+" "+strings.Trim(string(raw), `"`))
			}
			sort.Strings(parts)
			return oneLine(strings.Join(parts, "; "), 300)
		case []any:
			raw, _ := json.Marshal(t)
			return oneLine(string(raw), 80)
		case float64:
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
		return fmt.Sprint(v)
	}
	keys := make([]string, 0, len(changes))
	for k := range changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, f := range keys {
		ch := changes[f]
		if quietFields[f] {
			if f == "deleted_at" {
				if ch.To != nil && ch.To != float64(0) {
					parts = append(parts, "moved to trash")
				} else {
					parts = append(parts, "restored")
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
func waitsOn(nm *names, t core.Task) string {
	if t.WaitingOutside {
		return "outside"
	}
	return nm.handle(t.WaitingOnID)
}
