package importer

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"strings"
)

// csvCells gives a row's cells by column name: the first of the named
// columns that has a value.
type csvCells func(names ...string) string

// newCSV opens a reader that takes what exports really hold: rows of
// uneven length, stray quotes.
func newCSV(in io.Reader) *csv.Reader {
	r := csv.NewReader(in)
	r.FieldsPerRecord, r.LazyQuotes = -1, true
	return r
}

// readCSV reads a CSV export of tasks, one row a task, as row makes it. A
// row that gives no title is skipped.
func readCSV(path, source string, row func(csvCells) Task) (Plan, error) {
	plan := Plan{Source: source}
	f, err := os.Open(path)
	if err != nil {
		return plan, err
	}
	defer f.Close()
	r := newCSV(f)
	head, err := r.Read()
	if err != nil {
		return plan, fmt.Errorf("%s: %w", path, err)
	}
	col := map[string]int{}
	for i, h := range head {
		col[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))] = i
	}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			return plan, nil
		}
		if err != nil {
			return plan, fmt.Errorf("%s: %w", path, err)
		}
		cells := func(names ...string) string {
			for _, n := range names {
				if i, ok := col[n]; ok && i < len(rec) && strings.TrimSpace(rec[i]) != "" {
					return strings.TrimSpace(rec[i])
				}
			}
			return ""
		}
		if t := row(cells); t.Title != "" {
			plan.Tasks = append(plan.Tasks, t)
		}
	}
}
