package server

import (
	"slices"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// TestFlowWeeksAreTheLastTwelveMondays checks that the dashboard's weekly
// series is twelve weeks in a row, each named by its Monday, also when the
// server's clock changed in between: stepped in the server's own zone, a
// week before the change lands on the Sunday before its Monday, and one
// week is named twice while another is left out.
func TestFlowWeeksAreTheLastTwelveMondays(t *testing.T) {
	t.Parallel()
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no time zone data here:", err)
	}
	// Sunday evening in New York, already Monday in UTC; clocks went back on 1 November.
	weeks := flowWeekly(dashboardScope{now: time.Date(2026, 11, 15, 19, 2, 0, 0, zone)})
	if len(weeks) != flowWeeks {
		t.Fatalf("%d weeks, want %d", len(weeks), flowWeeks)
	}
	monday := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	for i, week := range slices.Backward(weeks) {
		if want := monday.Format(time.DateOnly); week.Week != want {
			t.Errorf("week %d of the series is %s, want %s", i, week.Week, want)
		}
		monday = monday.AddDate(0, 0, -7)
	}
}

// TestFlowByStatusLeavesOutProjectsInTheTrash: the statuses of a project in
// the trash are not counted; they stay stored with it, to come back if it
// is restored.
func TestFlowByStatusLeavesOutProjectsInTheTrash(t *testing.T) {
	t.Parallel()
	names := &nameLookup{
		projects: map[string]core.Project{"p1": {ID: "p1", Key: "SVA"}, "p2": {ID: "p2", Key: "GS", DeletedAt: 1}},
		statuses: map[string]core.Status{
			"s1": {ID: "s1", ProjectID: "p1", Name: "Todo", Category: core.CatUnstarted},
			"s2": {ID: "s2", ProjectID: "p2", Name: "Todo", Category: core.CatUnstarted},
		},
	}
	who := &viewer{}
	got := who.flowByStatus(dashboardScope{names: names, covers: who})
	if len(got) != 1 || got[0].Project != "SVA" {
		t.Fatalf("the flow by status is %+v, want SVA's Todo alone", got)
	}
}
