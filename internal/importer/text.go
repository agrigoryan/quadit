package importer

import (
	"regexp"
	"strings"
)

// category guesses a status category from a status's name.
func category(name string) string {
	n := strings.ToLower(name)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(n, w) {
				return true
			}
		}
		return false
	}
	switch {
	case has("cancel", "duplicate", "won't", "wont"):
		return "canceled"
	case has("done", "complete", "closed", "shipped", "merged"):
		return "done"
	case has("wait", "blocked", "hold"):
		return "waiting"
	case has("progress", "doing", "review", "started"):
		return "started"
	case has("backlog", "icebox", "triage", "someday"):
		return "backlog"
	}
	return "unstarted"
}

// priorityNames gives our number for a priority's name elsewhere.
var priorityNames = map[string]int{"urgent": 1, "high": 2, "medium": 3, "normal": 3, "low": 4}

var keyClean = regexp.MustCompile(`[^A-Z0-9]`)

// KeyFrom makes a project key out of a name.
func KeyFrom(name string) string {
	k := keyClean.ReplaceAllString(strings.ToUpper(name), "")
	if len(k) > 6 {
		k = k[:6]
	}
	for len(k) < 2 || k[0] < 'A' || k[0] > 'Z' {
		k = "P" + k
	}
	return k
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
