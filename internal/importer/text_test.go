package importer

import "testing"

func TestCategory(t *testing.T) {
	cases := map[string]string{
		"Canceled":       "canceled",
		"Won't do":       "canceled",
		"Duplicate":      "canceled",
		"Done":           "done",
		"Completed":      "done",
		"Merged":         "done",
		"Waiting on you": "waiting",
		"Blocked":        "waiting",
		"On hold":        "waiting",
		"In Progress":    "started",
		"In review":      "started",
		"Backlog":        "backlog",
		"Icebox":         "backlog",
		"Todo":           "unstarted",
		"":               "unstarted",
		// The first kind that matches wins: a canceled one that was done.
		"Done (canceled)": "canceled",
	}
	for name, want := range cases {
		if got := category(name); got != want {
			t.Errorf("category(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestKeyFrom(t *testing.T) {
	cases := map[string]string{
		"eng":             "ENG",
		"Mobile App":      "MOBILE",
		"Engineering":     "ENGINE",
		"a":               "PA",
		"":                "PP",
		"42 things":       "P42THIN", // cut to six, then made to start with a letter
		"web-2":           "WEB2",
		"Ünïcode project": "NCODEP", // letters outside A-Z are dropped
	}
	for name, want := range cases {
		if got := KeyFrom(name); got != want {
			t.Errorf("KeyFrom(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestPriorityNames(t *testing.T) {
	cases := map[string]int{"urgent": 1, "high": 2, "medium": 3, "normal": 3, "low": 4, "none": 0, "": 0, "High": 0}
	for name, want := range cases {
		if got := priorityNames[name]; got != want {
			t.Errorf("priorityNames[%q] = %d, want %d", name, got, want)
		}
	}
}
