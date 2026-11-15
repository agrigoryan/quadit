// Small helpers on names that several sources share: status categories,
// priorities and project keys.

package importer

import (
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
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
		return core.CatCanceled
	case has("done", "complete", "closed", "shipped", "merged"):
		return core.CatDone
	case has("wait", "blocked", "hold"):
		return core.CatWaiting
	case has("progress", "doing", "review", "started"):
		return core.CatStarted
	case has("backlog", "icebox", "triage", "someday"):
		return core.CatBacklog
	}
	return core.CatUnstarted
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
