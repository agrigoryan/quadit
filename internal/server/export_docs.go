package server

import (
	"encoding/csv"
	"fmt"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/formula"
	"github.com/agrigoryan/quadit/internal/md"
)

// docs/ of an export: the page tree as folders of Markdown.

// docs writes docs/: the page tree as folders of Markdown; private pages of
// others stay out.
func (e *exporter) docs(rows *exportRows) error {
	blocksOf := map[string][]core.Block{}
	for _, bl := range rows.blocks {
		blocksOf[bl.DocID] = append(blocksOf[bl.DocID], bl)
	}
	byID := map[string]core.Doc{}
	for _, d := range rows.docs {
		byID[d.ID] = d
	}
	used := map[string]bool{}
	for _, d := range rows.docs {
		if !e.who.canSeeDoc(d) {
			continue
		}
		path := "docs/" + docPath(byID, d, 0)
		for n := 2; used[path]; n++ {
			path = fmt.Sprintf("docs/%s (%d)", docPath(byID, d, 0), n)
		}
		used[path] = true
		if d.Kind == core.DocDatabase {
			if err := e.databaseCSV(path+".csv", d); err != nil {
				return err
			}
			continue
		}
		if err := e.addTextFile(path+".md", md.Render(engine.BlockTree(blocksOf[d.ID]))); err != nil {
			return err
		}
	}
	return nil
}

// docPath is where a page goes under docs/: its title under those of the
// pages above it.
func docPath(byID map[string]core.Doc, d core.Doc, depth int) string {
	name := fileSafe(firstNonEmpty(d.Title, "Untitled"))
	if p, ok := byID[d.ParentID]; ok && depth < 30 {
		return docPath(byID, p, depth+1) + "/" + name
	}
	return name
}

// databaseCSV writes a database as a table: a line per row, a column per
// property, every cell as it is shown.
func (e *exporter) databaseCSV(name string, d core.Doc) error {
	t, err := e.who.loadTable(e.ctx, d)
	if err != nil {
		return err
	}
	cells, err := e.who.computed(e.ctx, t)
	if err != nil {
		return err
	}
	w, err := e.zw.Create(name)
	if err != nil {
		return err
	}
	head := []string{"Title"}
	for _, p := range t.props {
		head = append(head, p.Name)
	}
	records := [][]string{head}
	for _, r := range t.rows {
		row := []string{r.Title}
		for _, p := range t.props {
			row = append(row, formula.Text(cells[r.ID][p.ID]))
		}
		records = append(records, row)
	}
	// A database the export could not write in full fails the export.
	return csv.NewWriter(w).WriteAll(records)
}
