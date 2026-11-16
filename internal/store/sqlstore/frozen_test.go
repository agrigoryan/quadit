package sqlstore

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"sort"
	"strings"
	"testing"
)

// TestMigrationsAreFrozen holds released schema files still. An install
// that has applied a migration never runs it again, so changing the file
// would leave that install without the change: every change to the schema
// is a new file with the next number. The files and their checksums are in
// testdata/migrations.txt; a new file is added to it by running the test
// with QUADIT_UPDATE_MIGRATIONS=1, which never rewrites a line.
func TestMigrationsAreFrozen(t *testing.T) {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	now := map[string]string{}
	for _, e := range entries {
		body, err := migrationFiles.ReadFile("migrations/" + e.Name())
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		now[e.Name()] = hex.EncodeToString(sum[:])
	}
	const file = "testdata/migrations.txt"
	raw, _ := os.ReadFile(file)
	known := map[string]string{}
	var lines []string
	for l := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		if name, sum, ok := strings.Cut(l, " "); ok && !strings.HasPrefix(l, "#") {
			known[name] = sum
			lines = append(lines, l)
		}
	}
	for name, sum := range known {
		switch got, ok := now[name]; {
		case !ok:
			t.Errorf("%s was released and is gone", name)
		case got != sum:
			t.Errorf("%s was released and has been edited; put the change in a new migration file instead", name)
		}
	}
	var added []string
	for name, sum := range now {
		if _, ok := known[name]; !ok {
			added = append(added, name+" "+sum)
		}
	}
	if len(added) == 0 || t.Failed() {
		return
	}
	if os.Getenv("QUADIT_UPDATE_MIGRATIONS") == "" {
		t.Fatalf("new migration files are not recorded yet: run the test once with QUADIT_UPDATE_MIGRATIONS=1\n  %s", strings.Join(added, "\n  "))
	}
	all := append(lines, added...)
	sort.Strings(all)
	os.MkdirAll("testdata", 0o755)
	if err := os.WriteFile(file, []byte("# Released schema files and their checksums. Lines are only ever added.\n"+strings.Join(all, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
