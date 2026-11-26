// Checking a task's fields: priority, estimate, epic, milestone, cycle.

package engine

import (
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// The rules for a task's fields that making a task (ch_task.go) and
// changing one (ch_task_update.go) both hold to.

const priorityHelp = "priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)"

func priorityOK(n int) bool { return n >= 0 && n <= 4 }

// taskEstimate is the estimate a change names for a task of a project with
// these settings: nil for none. A 0 is none where the project does not take
// 0 as an estimate of its own, as it always was. Where the project
// estimates on a scale, an estimate off it is refused, in the project's
// words; elsewhere any whole number is taken.
func taskEstimate(s *core.ProjectSettings, n int) (*int, error) {
	values := s.EstimateValues()
	switch {
	case n == 0 && !s.ZeroEstimates():
		return nil, nil
	case values != nil && !slices.Contains(values, n):
		return nil, invalid("estimate", "this project estimates in %s", s.EstimateWords())
	case n < 0:
		return nil, invalid("estimate", estimateHelp)
	}
	return &n, nil
}

const estimateHelp = "an estimate is a number of points, 0 or more"

// isOutside reports whether a "waiting on" names no member but an outside
// event: a build, a delivery, a date, someone who is not here.
func isOutside(ref string) bool {
	switch strings.ToLower(strings.TrimSpace(ref)) {
	case "outside", "external", "event":
		return true
	}
	return false
}

// checkOutsideNote holds a task that waits on an outside event to saying
// which: the note is all there is to tell anyone what it waits for.
func checkOutsideNote(note string) error {
	if strings.TrimSpace(note) == "" {
		return invalid("waiting_on_note", "say what outside event the task waits for, in waiting_on_note")
	}
	return nil
}

// refOf is the reference an optional argument gives. Null, like "", names
// nothing.
func refOf(o Opt[string]) string {
	if o.Null {
		return ""
	}
	return o.V
}

// taskEpic is the id of the epic a task names; "" names none.
func (c *cx) taskEpic(project core.Project, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	e, err := c.epic(project, "epic", ref)
	return e.ID, err
}

// taskMilestone finds the milestone a task names. A milestone belongs to
// its epic: a task in another epic cannot be put in it, and a task in none
// goes into the milestone's.
func (c *cx) taskMilestone(ref, epicID string) (core.Milestone, error) {
	ms, err := loadLive[core.Milestone](c, "milestone", "milestone", ref)
	if err != nil {
		return ms, err
	}
	if epicID != "" && ms.EpicID != epicID {
		return ms, invalid("milestone", "that milestone belongs to another epic")
	}
	return ms, nil
}

// taskCycle is the id of the cycle a task names; "" names none.
func (c *cx) taskCycle(project core.Project, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	cy, err := c.cycle(project, "cycle", ref)
	return cy.ID, err
}
