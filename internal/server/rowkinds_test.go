package server

import (
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
)

// notRowKinds are the tables of a workspace that are not a kind of row in
// rowKinds, each with where its rows are read instead.
var notRowKinds = map[string]string{
	"tasks":         "the task reads, and page by page in the starting copy and the export",
	"events":        "the feed, and page by page in the export",
	"api_tokens":    "GET /tokens, to the member they are for and to admins",
	"connect_codes": "GET /connect-codes/{id}, to the person who made the code",
	"task_labels":   "part of its task",
	"doc_versions":  "GET /docs/{id}/versions, with the page",
	"db_views":      "GET /docs/{id}, with the database",
	"doc_sources":   "GET /sources",
	"changes":       "never read out: the engine's record of what it applied",
	"cursors":       "GET /cursors/{name}, each member's own",
	"refs":          "with the task or the page that is mentioned",
	"doc_presence":  "POST /docs/{id}/presence, with the page",
	"task_keys":     "never read out: the keys a task had before it moved",
}

// TestEveryWorkspaceTableIsARowKindOrSaysWhereItIsRead holds the list of
// row kinds to the tables there are: a new table of a workspace is given a
// rule for who may see its rows (rowKinds), or says here where it is read.
func TestEveryWorkspaceTableIsARowKindOrSaysWhereItIsRead(t *testing.T) {
	kindOf := map[string]string{}
	for _, kind := range rowKinds {
		if _, twice := kindOf[kind.name]; twice {
			t.Errorf("two row kinds are named %s", kind.name)
		}
		table, ok := store.TableOf(kind.row)
		if !ok {
			t.Errorf("row kind %s is of a type that is no table", kind.name)
			continue
		}
		kindOf[table.Name] = kind.name
		if kind.list == nil && kind.copyQuery == nil && kind.exportQuery == nil {
			t.Errorf("row kind %s is in no read", kind.name)
		}
	}
	for _, table := range store.Tables() {
		if table.Global {
			continue
		}
		_, isKind := kindOf[table.Name]
		_, excused := notRowKinds[table.Name]
		switch {
		case isKind && excused:
			t.Errorf("table %s is a row kind and is also said not to be", table.Name)
		case !isKind && !excused:
			t.Errorf("table %s is a workspace's and no row kind: add it to rowKinds with the rule for who may see its rows, or to notRowKinds with where it is read", table.Name)
		}
	}
}

// TestOnlyAKindWithARuleIsListedOrCopied: a kind of row with no rule for
// who may see a row (exportOnly) is read by the export alone, which is the
// whole workspace's: it is never given to /list or the starting copy, which
// limited callers read.
func TestOnlyAKindWithARuleIsListedOrCopied(t *testing.T) {
	for _, kind := range rowKinds {
		if kind.visible == nil && (kind.list != nil || kind.copyQuery != nil) {
			t.Errorf("row kind %s has no rule for who may see its rows, and is listed or copied", kind.name)
		}
	}
}
