package sqlstore

import (
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"testing/fstest"
)

// The schema is written once, for every database:
//
//	0001_core.sql              every database, with {{TYPE}} macros
//	0006_search.sqlite.sql     SQLite only (for example full-text tables)
//	0006_search.postgres.sql   Postgres only
//
// goose reads plain SQL, one file per schema version. gooseFiles makes
// those files from these, in memory, each time a database is opened. For
// one version it
//
//  1. takes the shared file, then the file for this database, if any;
//  2. replaces each {{TYPE}} macro with the database's own column type;
//  3. drops blank lines and lines that are only a comment;
//  4. puts "-- +goose Up" on top, which goose asks of every file.
//
// The statements goose then runs are, byte for byte, the ones the runner
// before goose ran (TestMigrationsRunAsBefore).
//
//go:embed migrations/*.sql
var migrationFiles embed.FS

// gooseUp marks what follows as the way up. There is no way down: going
// back is the copy made before an upgrade.
const gooseUp = "-- +goose Up\n"

// schemaVersion is one version of the schema, for one database.
type schemaVersion struct {
	number int
	name   string
	sql    string // steps 1 to 3
}

// file is the name goose reads the version under: 0006_search.sql.
func (v schemaVersion) file() string { return fmt.Sprintf("%04d_%s.sql", v.number, v.name) }

// gooseFiles is every schema version as goose reads it for a database.
func gooseFiles(d Dialect) (fs.FS, []schemaVersion, error) {
	versions, err := schemaVersions(d)
	if err != nil {
		return nil, nil, err
	}
	files := fstest.MapFS{} // the standard library's in-memory file system
	for _, v := range versions {
		files[v.file()] = &fstest.MapFile{Data: []byte(gooseUp + v.sql)}
	}
	return files, versions, nil
}

// schemaVersions reads the embedded files into versions 1, 2, 3, … for a
// database.
func schemaVersions(d Dialect) ([]schemaVersion, error) {
	names, err := migrationNames()
	if err != nil {
		return nil, err
	}
	var out []schemaVersion
	for _, name := range names {
		number, title, only, err := parseMigrationName(name)
		if err != nil {
			return nil, err
		}
		if only != "" && only != d.Name {
			continue // another database's file
		}
		body, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].number != number {
			out = append(out, schemaVersion{number: number, name: title})
		}
		out[len(out)-1].sql += statementLines(d.expand(string(body)))
	}
	for i, v := range out {
		if v.number != i+1 {
			return nil, fmt.Errorf("migrations: version %d missing", i+1)
		}
	}
	return out, nil
}

// migrationNames lists the embedded files by version, the shared file of a
// version before a database's own.
func migrationNames() ([]string, error) {
	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Slice(names, func(i, j int) bool {
		if vi, vj := names[i][:4], names[j][:4]; vi != vj {
			return vi < vj
		}
		if si, sj := isShared(names[i]), isShared(names[j]); si != sj {
			return si
		}
		return names[i] < names[j]
	})
	return names, nil
}

func isShared(name string) bool { return strings.Count(name, ".") == 1 }

// parseMigrationName reads NNNN_name[.database].sql.
func parseMigrationName(file string) (number int, name, only string, err error) {
	parts := strings.Split(strings.TrimSuffix(file, ".sql"), ".")
	if len(parts) > 2 || len(parts[0]) < 6 || parts[0][4] != '_' {
		return 0, "", "", fmt.Errorf("migration %q: want NNNN_name[.database].sql", file)
	}
	if number, err = strconv.Atoi(parts[0][:4]); err != nil {
		return 0, "", "", fmt.Errorf("migration %q: bad version: %w", file, err)
	}
	if len(parts) == 2 {
		only = parts[1]
	}
	return number, parts[0][5:], only, nil
}

// statementLines drops blank lines and lines that are only a comment.
// Migrations keep to plain DDL: a statement ends at a semicolon that ends
// a line, which is where goose cuts.
func statementLines(sqlText string) string {
	var b strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}
