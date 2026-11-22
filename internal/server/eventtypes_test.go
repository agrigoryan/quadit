package server

import (
	"os"
	"slices"
	"strings"
	"testing"
)

// notForListeners are the event types the engine writes that the list for
// webhook and rule forms leaves out, each with why.
var notForListeners = map[string]string{
	"watcher.created": "addressed to the watcher alone: no webhook or rule is given it",
	"watcher.deleted": "addressed to the watcher alone: no webhook or rule is given it",
}

// TestEventTypesAreTheOnesTheEngineWrites holds the list of event types
// offered to webhooks and rules to what the engine writes. The engine's
// own test (internal/engine, TestEventPayloads) runs every change type and
// records each event in testdata/events.golden; every type there is in the
// list or says here why not, and the list names no type that is never
// written.
func TestEventTypesAreTheOnesTheEngineWrites(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../engine/testdata/events.golden")
	if err != nil {
		t.Fatal(err)
	}
	written := map[string]bool{}
	for line := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		typ, _, _ := strings.Cut(line, " ")
		written[typ] = true
	}
	if len(written) < 50 {
		t.Fatalf("read only %d event types from the engine's recording", len(written))
	}
	for typ := range written {
		_, excused := notForListeners[typ]
		switch listed := slices.Contains(eventTypes, typ); {
		case !listed && !excused:
			t.Errorf("the engine writes %s, which eventTypes does not list: add it there, or to notForListeners with the reason", typ)
		case listed && excused:
			t.Errorf("%s is listed and is also said not to be", typ)
		}
	}
	for _, typ := range eventTypes {
		if !written[typ] {
			t.Errorf("eventTypes lists %s, which the engine never writes", typ)
		}
	}
}
