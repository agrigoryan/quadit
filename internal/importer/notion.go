// The Notion source: the zip of Markdown and CSV that Notion exports.

package importer

import (
	"net/http"
	"os"
	"regexp"
	"strings"
)

// notion reads a Notion export: the zip it gives, or that zip unpacked. It
// is a folder of Markdown with three habits of its own: every name ends in
// an id, every page repeats its title as its first heading, and a database
// is a CSV file.
type notion struct{}

func (notion) Kind() string { return "notion" }

// Read reads the export at source: the zip, or a folder it was unpacked into.
func (notion) Read(source string, _ Options, _ *http.Client) (Plan, error) {
	dir, tmp, err := unpacked(source, "notion", zipAnyFile)
	if err != nil {
		return Plan{}, err
	}
	return (&tree{source: "notion", root: dir, tmp: tmp, title: notionTitle, body: notionBody, table: notionTable}).read()
}

var notionID = regexp.MustCompile(`\s+[0-9a-f]{32}$`)

func notionTitle(name string) string { return notionID.ReplaceAllString(name, "") }

func notionBody(title, text string) string {
	if first, rest, ok := strings.Cut(text, "\n"); ok && strings.TrimSpace(strings.TrimPrefix(first, "# ")) == title {
		return strings.TrimLeft(rest, "\n")
	}
	return text
}

// notionTable reads a database's CSV. Notion writes each database twice;
// the "_all" copy is left out.
func notionTable(path string) (cols []string, rows [][]string, ok bool) {
	if !strings.HasSuffix(strings.ToLower(path), ".csv") || strings.HasSuffix(strings.TrimSuffix(path, ".csv"), "_all") {
		return nil, nil, false
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, false
	}
	defer f.Close()
	recs, err := newCSV(f).ReadAll()
	if err != nil || len(recs) == 0 {
		return nil, nil, false
	}
	recs[0][0] = strings.TrimPrefix(recs[0][0], "\ufeff")
	return recs[0], recs[1:], true
}
