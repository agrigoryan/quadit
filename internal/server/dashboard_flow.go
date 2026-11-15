package server

import (
	"sort"
	"strings"
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

func (d *dashboard) flowByStatus() []flowStatus {
	names := d.names
	count := map[string]int{}
	for _, t := range d.tasks {
		if t.ArchivedAt == 0 {
			count[t.StatusID]++
		}
	}
	var sts []core.Status
	for _, st := range names.statuses {
		if st.DeletedAt == 0 && (len(d.projects) == 0 || has(d.projects, st.ProjectID)) && d.x.canProject(st.ProjectID) {
			sts = append(sts, st)
		}
	}
	sort.Slice(sts, func(i, j int) bool { return statusBefore(sts[i], sts[j]) })
	var out []flowStatus
	for _, st := range sts {
		out = append(out, flowStatus{Status: st.Name, Category: st.Category, Project: names.projects[st.ProjectID].Key, Count: count[st.ID]})
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
	return t.Format("2006-01-02")
}

// flowWeekly counts the last twelve weeks.
func (d *dashboard) flowWeekly() []flowWeek {
	weeks := map[string][2]int{} // opened, closed
	cutoff := d.now.AddDate(0, 0, -7*12).UnixMilli()
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
	for day := d.now.AddDate(0, 0, -7*11); !day.After(d.now); day = day.AddDate(0, 0, 7) {
		k := weekOf(day.UnixMilli())
		out = append(out, flowWeek{Week: k, Opened: weeks[k][0], Closed: weeks[k][1]})
	}
	return out
}

// flowWait is the open tasks that wait on one member, and for how long.
type flowWait struct {
	Member string  `json:"member"`
	Kind   string  `json:"kind"`
	Tasks  int     `json:"tasks"`
	Hours  float64 `json:"avg_hours"`
	Oldest float64 `json:"oldest_hours"`
}

// flowWaiting says how long each open task has waited on its member: since
// the last change that handed it to them.
func (d *dashboard) flowWaiting() ([]flowWait, error) {
	names := d.names
	since := map[string]int64{}
	evs, err := d.x.db.Events(d.x.ctx(), store.EventFilter{Types: []string{"task.updated", "task.created"}, ProjectIDs: d.projects, Desc: true, Limit: 2000})
	if err != nil {
		return nil, err
	}
	for _, ev := range evs {
		if _, seen := since[ev.ScopeID]; seen || !strings.Contains(string(ev.Data), "waiting_on_id") {
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
		h := float64(d.now.UnixMilli()-at) / 3600_000
		wt := waits[t.WaitingOnID]
		if wt == nil {
			wt = &flowWait{Member: names.handle(t.WaitingOnID), Kind: names.members[t.WaitingOnID].Kind}
			waits[t.WaitingOnID] = wt
		}
		wt.Tasks++
		wt.Hours += h
		wt.Oldest = max(wt.Oldest, h)
	}
	var out []flowWait
	for _, wt := range waits {
		wt.Hours = float64(int(wt.Hours/float64(wt.Tasks)*10)) / 10
		wt.Oldest = float64(int(wt.Oldest*10)) / 10
		out = append(out, *wt)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Oldest != out[j].Oldest {
			return out[i].Oldest > out[j].Oldest
		}
		return out[i].Member < out[j].Member
	})
	return out, nil
}
