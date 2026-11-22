package auth

import (
	"strings"
	"testing"
)

// A test binary hashes at testCost (see cost), so the cost the server
// hashes at is checked here, once.
func TestTheServerHashesAtFullCost(t *testing.T) {
	h, err := hashAt("correct horse", serverCost)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=65536,t=3,p=2$") {
		t.Fatalf("hash = %s, want Argon2id at 64 MB, 3 passes, 2 threads", h)
	}
	if !CheckPassword(h, "correct horse") || CheckPassword(h, "wrong") {
		t.Fatal("a hash at the server's cost does not check out")
	}
}
