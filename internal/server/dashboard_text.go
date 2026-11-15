// The dashboard as text.

package server

import (
	"encoding/json"
	"fmt"
	"strings"
)

// dashboardText is the dashboard in the compact text form: what waits on
// the caller, epics, tasks by status, the longest waits, agents and health.
func (d *dashboard) dashboardText() string {
	raw, _ := json.Marshal(d.machinery) // cannot fail: numbers, strings and bools
	var b strings.Builder
	fmt.Fprintf(&b, "== waiting on you (%d)\n%s", len(d.waiting), lines(d.waiting, taskView.line, "nothing"))
	b.WriteString("== epics\n")
	for _, e := range d.epics {
		fmt.Fprintf(&b, "%s  %s  %d/%d done", e.Project, e.Name, e.Done, e.Total)
		if e.TargetOn != "" {
			b.WriteString("  target " + e.TargetOn)
		}
		if e.AtRisk != "" {
			b.WriteString("  AT RISK: " + e.AtRisk)
		}
		b.WriteString("\n")
	}
	b.WriteString("== status\n")
	for _, status := range d.byStatus {
		if status.Count > 0 {
			fmt.Fprintf(&b, "%s %s: %d\n", status.Project, status.Status, status.Count)
		}
	}
	b.WriteString("== waiting longest\n")
	for _, wait := range d.waits {
		fmt.Fprintf(&b, "%s  %d tasks, oldest %.1fh, average %.1fh\n", wait.Member, wait.Tasks, wait.Oldest, wait.Hours)
	}
	b.WriteString("== agents\n")
	for _, a := range d.agents {
		fmt.Fprintf(&b, "%s  %s %s\n", a.Handle, strings.ReplaceAll(a.State, "_", " "), a.Task)
	}
	fmt.Fprintf(&b, "== health\n%s\n", raw)
	return b.String()
}
