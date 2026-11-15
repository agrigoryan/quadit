package importer

import (
	"fmt"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
)

// networkRefusal stands for internal/cli's APIError, a refusal as it comes
// over the network, which this package's tests cannot import.
type networkRefusal struct{ message, reason string }

func (e *networkRefusal) Error() string         { return "conflict: " + e.message }
func (e *networkRefusal) RefusalReason() string { return e.reason }

// TestRefusalsAreKnownByTheirReason: the refusals an import gets past are
// told apart by the reason the API gives, from inside the server and over
// the network alike, not by the words of their message.
func TestRefusalsAreKnownByTheirReason(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		reason string
		want   bool
	}{
		{"a number taken, in the server", &engine.Error{Code: engine.CodeConflict, Message: "SVA-3 is taken", Reason: engine.ReasonNumberTaken}, refusalNumberTaken, true},
		{"a number taken, over the network", fmt.Errorf("task.create: %w", &networkRefusal{"SVA-3 is taken", "number_taken"}), refusalNumberTaken, true},
		{"a file id in use is not a number taken", &engine.Error{Code: engine.CodeConflict, Message: "that file id is taken", Reason: engine.ReasonInUse}, refusalNumberTaken, false},
		{"a handle taken is not a number taken", &networkRefusal{"the handle @bea is taken", ""}, refusalNumberTaken, false},
		{"an id in use", &engine.Error{Code: engine.CodeConflict, Message: `id "x" is already in use`, Reason: engine.ReasonInUse}, refusalAlreadyInUse, true},
		{"not a refusal", fmt.Errorf("the network is down: is already in use"), refusalAlreadyInUse, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := refusedFor(c.err, c.reason); got != c.want {
				t.Fatalf("refusedFor(%v, %q) = %v, want %v", c.err, c.reason, got, c.want)
			}
		})
	}
}
