// The dashboard's flow part: tasks by status, opened and closed by week, and
// how long work waits on each member.

package server

import (
	"slices"
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// flow fills in how work moves: tasks by status, opened and closed per
// week, waits per member.
func (d *dashboard) flow() error {
	d.byStatus = d.flowByStatus()
	d.weekly = d.flowWeekly()
	var err error
	d.waits, err = d.flowWaiting()
	return err
}

// flowStatus is how many tasks one status of one project holds.
type flowStatus struct {
	Status   string `json:"status"`
	Category string `json:"category"`
	Project  string `json:"project"`
	Count    int    `json:"count"`
}

// flowByStatus counts the tasks, archived ones left out, in each status of
// the projects the dashboard covers.
func (d *dashboard) flowByStatus() []flowStatus {
	names := d.names
	count := map[string]int{}
	for _, t := range d.tasks {
		if t.ArchivedAt == 0 {
			count[t.StatusID]++
		}
	}
	var statuses []core.Status
	for _, status := range names.statuses {
		if status.DeletedAt == 0 && (len(d.projects) == 0 || slices.Contains(d.projects, status.ProjectID)) && d.x.canProject(status.ProjectID) {
			statuses = append(statuses, status)
		}
	}
	sort.Slice(statuses, func(i, j int) bool { return statusBefore(statuses[i], statuses[j]) })
	var out []flowStatus
	for _, status := range statuses {
		out = append(out, flowStatus{Status: status.Name, Category: status.Category, Project: names.projects[status.ProjectID].Key, Count: count[status.ID]})
	}
	return out
}

// statusBefore orders statuses by project, then as the project ranks them,
// then by name and id where two have the same rank, so the same dashboard
// lists them in the same order every time.
func statusBefore(a, b core.Status) bool {
	if a.ProjectID != b.ProjectID {
		return a.ProjectID < b.ProjectID
	}
	if a.Rank != b.Rank {
		return a.Rank < b.Rank
	}
	if a.Name != b.Name {
		return a.Name < b.Name
	}
	return a.ID < b.ID
}

// flowWeek is the tasks opened and closed in one week, named by its Monday.
type flowWeek struct {
	Week   string `json:"week"`
	Opened int    `json:"opened"`
	Closed int    `json:"closed"`
}

// weekOf is the Monday of the week a moment falls in.
func weekOf(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	t = t.AddDate(0, 0, -((int(t.Weekday()) + 6) % 7))
	return t.Format(time.DateOnly)
}

// flowWeekly counts the tasks opened and closed in each of the last
// flowWeeks weeks.
func (d *dashboard) flowWeekly() []flowWeek {
	weeks := map[string][2]int{} // opened, closed
	cutoff := d.now.AddDate(0, 0, -7*flowWeeks).UnixMilli()
	for _, t := range d.tasks {
		if t.CreatedAt >= cutoff {
			w := weeks[weekOf(t.CreatedAt)]
			w[0]++
			weeks[weekOf(t.CreatedAt)] = w
		}
		if t.CompletedAt >= cutoff && t.CompletedAt != 0 {
			w := weeks[weekOf(t.CompletedAt)]
			w[1]++
			weeks[weekOf(t.CompletedAt)] = w
		}
	}
	var out []flowWeek
	for day := d.now.AddDate(0, 0, -7*(flowWeeks-1)); !day.After(d.now); day = day.AddDate(0, 0, 7) {
		k := weekOf(day.UnixMilli())
		out = append(out, flowWeek{Week: k, Opened: weeks[k][0], Closed: weeks[k][1]})
	}
	return out
}

// flowWeeks is how many weeks back the dashboard's flow counts; flowEvents
// how many of the latest task events it reads for the waits.
const (
	flowWeeks  = 12
	flowEvents = 2000
)

// flowWait is the open tasks that wait on one member, and for how long.
type flowWait struct {
	Member string  `json:"member"`
	Kind   string  `json:"kind"`
	Tasks  int     `json:"tasks"`
	Hours  float64 `json:"avg_hours"`
	Oldest float64 `json:"oldest_hours"`
}

// flowWaiting says how long each open task has waited on its member: since
// the last change that handed it to them, as the latest flowEvents task
// events tell, or else since the task last changed. Hours are given to a
// tenth, the members longest waited on first.
func (d *dashboard) flowWaiting() ([]flowWait, error) {
	names := d.names
	since := map[string]int64{}
	evs, err := d.x.db.Events(d.x.ctx(), store.EventFilter{Types: []string{"task.updated", "task.created"}, ProjectIDs: d.projects, Desc: true, Limit: flowEvents})
	if err != nil {
		return nil, err
	}
	for _, ev := range evs {
		d, _ := ev.Payload() // data that does not read hands the task to nobody
		if _, seen := since[ev.ScopeID]; seen || !d.Sets("waiting_on_id") {
			continue
		}
		since[ev.ScopeID] = ev.At
	}
	waits := map[string]*flowWait{}
	for _, t := range d.tasks {
		if t.WaitingOnID == "" || !core.OpenCategory(names.statuses[t.StatusID].Category) {
			continue
		}
		at := since[t.ID]
		if at == 0 {
			at = t.UpdatedAt
		}
		hours := float64(d.now.UnixMilli()-at) / float64(time.Hour.Milliseconds())
		wait := waits[t.WaitingOnID]
		if wait == nil {
			wait = &flowWait{Member: names.handle(t.WaitingOnID), Kind: names.members[t.WaitingOnID].Kind}
			waits[t.WaitingOnID] = wait
		}
		wait.Tasks++
		wait.Hours += hours
		wait.Oldest = max(wait.Oldest, hours)
	}
	var out []flowWait
	for _, wait := range waits {
		wait.Hours = float64(int(wait.Hours/float64(wait.Tasks)*10)) / 10
		wait.Oldest = float64(int(wait.Oldest*10)) / 10
		out = append(out, *wait)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Oldest != out[j].Oldest {
			return out[i].Oldest > out[j].Oldest
		}
		return out[i].Member < out[j].Member
	})
	return out, nil
}
