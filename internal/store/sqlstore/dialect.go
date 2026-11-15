package sqlstore

import (
	"strconv"
	"strings"
)

// Dialect holds what differs between the databases the SQL store runs on.
// Everything else (schema, queries, transactions) is shared.
type Dialect struct {
	// Name is "sqlite" or "postgres". Migration files with a
	// ".<name>.sql" suffix run only on that dialect.
	Name string

	// Types maps the type macros used in migrations ({{ID}}, {{TS}}, ...)
	// to this database's column types.
	Types map[string]string

	// Numbered is true when placeholders are $1, $2, ... instead of ?.
	Numbered bool

	// SingleWriter is true when the database allows one write transaction
	// at a time. Writers then queue in this process instead of retrying
	// against the database's lock.
	SingleWriter bool

	// search is the database's full-text index.
	search searcher

	// notify tells other servers sharing the database that a feed moved;
	// nil when only one server uses the database.
	notify notifier
}

// SQLite is the dialect for the default single-file install.
var SQLite = Dialect{
	Name: "sqlite",
	Types: map[string]string{
		"ID":     "TEXT",    // canonical UUID text
		"TS":     "INTEGER", // Unix milliseconds, UTC
		"BIGINT": "INTEGER",
		"INT":    "INTEGER",
		"BOOL":   "INTEGER", // 0 or 1
		"JSON":   "TEXT",
		"BYTES":  "BLOB",
	},
	SingleWriter: true,
	search:       ftsSearch{},
}

// Postgres is the dialect for larger installs.
var Postgres = Dialect{
	Name: "postgres",
	Types: map[string]string{
		"ID":     "UUID",
		"TS":     "BIGINT", // Unix milliseconds, UTC: same as SQLite, so queries are shared
		"BIGINT": "BIGINT",
		"INT":    "INTEGER",
		"BOOL":   "BOOLEAN",
		"JSON":   "JSONB",
		"BYTES":  "BYTEA",
	},
	Numbered: true,
	search:   tsvSearch{},
	notify:   pgNotify{},
}

// Rebind turns the ? placeholders every query is written with into the
// dialect's own form. Queries never contain a literal question mark.
func (d Dialect) Rebind(q string) string {
	if !d.Numbered || !strings.Contains(q, "?") {
		return q
	}
	var b strings.Builder
	b.Grow(len(q) + 8)
	n := 0
	for i := 0; i < len(q); i++ {
		if q[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(q[i])
	}
	return b.String()
}

// expand replaces the {{MACRO}} type names in a migration.
func (d Dialect) expand(sqlText string) string {
	for k, v := range d.Types {
		sqlText = strings.ReplaceAll(sqlText, "{{"+k+"}}", v)
	}
	return sqlText
}
