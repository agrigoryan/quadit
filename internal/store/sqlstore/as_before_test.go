package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// TestMigrationsRunAsBefore holds goose to the statements the runner before
// it ran: for every schema version, on each database, what goose executes
// is the same list of statements, byte for byte. An install made before
// goose and one made after therefore have the same schema.
func TestMigrationsRunAsBefore(t *testing.T) {
	t.Run("sqlite", func(t *testing.T) {
		db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "quadit.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		sameAsBefore(t, New(db, SQLite))
	})
	t.Run("postgres", func(t *testing.T) {
		url := os.Getenv("QUADIT_TEST_POSTGRES")
		if url == "" {
			t.Skip("QUADIT_TEST_POSTGRES is not set")
		}
		schema := fmt.Sprintf("t%d", time.Now().UnixNano())
		admin, err := sql.Open("pgx", url)
		if err != nil {
			t.Fatal(err)
		}
		defer admin.Close()
		if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
			t.Fatal(err)
		}
		defer admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		db, err := sql.Open("pgx", url+sep+"search_path="+schema)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		sameAsBefore(t, New(db, Postgres))
	})
}

func sameAsBefore(t *testing.T, s *Store) {
	t.Helper()
	before, err := statementsBeforeGoose(s.d)
	if err != nil {
		t.Fatal(err)
	}
	ran := &statementLog{byVersion: map[int64][]string{}}
	runner, err := s.migrator(goose.WithVerbose(true), goose.WithSlog(slog.New(ran)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Up(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ran.byVersion) != len(before) {
		t.Fatalf("goose ran %d versions, the runner before it ran %d", len(ran.byVersion), len(before))
	}
	statements := 0
	for i, want := range before {
		got := ran.byVersion[int64(i+1)]
		if !slices.Equal(got, want) {
			t.Errorf("version %d: goose ran %d statements, before it was %d; the first that differs:\n%s", i+1, len(got), len(want), firstDifference(got, want))
		}
		statements += len(want)
	}
	t.Logf("%s: %d versions, %d statements, the same as before goose", s.d.Name, len(before), statements)
}

func firstDifference(got, want []string) string {
	for i := range want {
		if i >= len(got) {
			return "goose stopped before:\n" + want[i]
		}
		if got[i] != want[i] {
			return "goose:\n" + got[i] + "\nbefore:\n" + want[i]
		}
	}
	return "goose ran more:\n" + got[len(want)]
}

// statementLog collects the statements goose says it executes.
type statementLog struct {
	slog.Handler
	byVersion map[int64][]string
}

func (l *statementLog) Enabled(context.Context, slog.Level) bool { return true }

func (l *statementLog) Handle(_ context.Context, r slog.Record) error {
	var version int64
	var statement string
	r.Attrs(func(a slog.Attr) bool {
		switch a.Key {
		case "version":
			version = a.Value.Int64()
		case "statement":
			statement = a.Value.String()
		}
		return true
	})
	if r.Message == "executing statement" {
		l.byVersion[version] = append(l.byVersion[version], statement)
	}
	return nil
}

// statementsBeforeGoose is the migration runner as it was before goose:
// how it read the files of a version and cut them into statements. It is
// kept here, unchanged, only to compare against.
func statementsBeforeGoose(d Dialect) ([][]string, error) {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	byVersion := map[int]string{}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Slice(names, func(i, j int) bool {
		si, sj := strings.Count(names[i], ".") == 1, strings.Count(names[j], ".") == 1
		vi, vj := names[i][:4], names[j][:4]
		if vi != vj {
			return vi < vj
		}
		if si != sj {
			return si
		}
		return names[i] < names[j]
	})
	for _, name := range names {
		base := strings.TrimSuffix(name, ".sql")
		parts := strings.Split(base, ".")
		if len(parts) == 2 && parts[1] != d.Name {
			continue
		}
		v, err := strconv.Atoi(parts[0][:4])
		if err != nil {
			return nil, err
		}
		body, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		byVersion[v] += d.expand(string(body)) + "\n"
	}
	out := make([][]string, len(byVersion))
	for v, text := range byVersion {
		out[v-1] = splitStatementsBeforeGoose(text)
	}
	return out, nil
}

func splitStatementsBeforeGoose(sqlText string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteByte('\n')
		if strings.HasSuffix(trimmed, ";") {
			out = append(out, strings.TrimSpace(cur.String()))
			cur.Reset()
		}
	}
	if rest := strings.TrimSpace(cur.String()); rest != "" {
		out = append(out, rest)
	}
	return out
}
