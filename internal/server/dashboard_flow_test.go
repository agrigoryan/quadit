package server

import (
	"slices"
	"testing"
	"time"
)

// TestFlowWeeksAreTheLastTwelveMondays checks that the dashboard's weekly
// series is twelve weeks in a row, each named by its Monday, also when the
// server's clock changed in between: stepped in the server's own zone, a
// week before the change lands on the Sunday before its Monday, and one
// week is named twice while another is left out.
func TestFlowWeeksAreTheLastTwelveMondays(t *testing.T) {
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no time zone data here:", err)
	}
	// Sunday evening in New York, already Monday in UTC; clocks went back on 1 November.
	d := &dashboard{now: time.Date(2026, 11, 15, 19, 2, 0, 0, zone)}
	weeks := d.flowWeekly()
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
