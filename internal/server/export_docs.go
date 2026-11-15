package server

import (
	"encoding/csv"
	"fmt"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/formula"
	"github.com/agrigoryan/quadit/internal/md"
)

// docs writes docs/: the page tree as folders of Markdown; private pages of
// others stay out.
func (e *exporter) docs() error {
	blocksOf := map[string][]core.Block{}
	for _, bl := range e.rows.blocks {
		blocksOf[bl.DocID] = append(blocksOf[bl.DocID], bl)
	}
	byID := map[string]core.Doc{}
	for _, d := range e.rows.docs {
		byID[d.ID] = d
	}
	used := map[string]bool{}
	for _, d := range e.rows.docs {
		if !engine.CanSeeDoc(d, e.x.member.UserID) {
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
		if err := e.put(path+".md", md.Render(engine.BlockTree(blocksOf[d.ID]))); err != nil {
			return err
		}
	}
	return nil
}

// docPath is where a page goes under docs/: its title under those of the
// pages above it.
func docPath(byID map[string]core.Doc, d core.Doc, depth int) string {
	name := fileSafe(orText(d.Title, "Untitled"))
	if p, ok := byID[d.ParentID]; ok && depth < 30 {
		return docPath(byID, p, depth+1) + "/" + name
	}
	return name
}

// databaseCSV writes a database as a table: a line per row, a column per
// property, every cell as it is shown.
func (e *exporter) databaseCSV(name string, d core.Doc) error {
	t, err := e.x.loadTable(d)
	if err != nil {
		return err
	}
	cells, err := e.x.computed(t)
	if err != nil {
		return err
	}
	w, err := e.zw.Create(name)
	if err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	head := []string{"Title"}
	for _, p := range t.props {
		head = append(head, p.Name)
	}
	cw.Write(head)
	for _, r := range t.rows {
		row := []string{r.Title}
		for _, p := range t.props {
			row = append(row, formula.Text(cells[r.ID][p.ID]))
		}
		cw.Write(row)
	}
	cw.Flush()
	return nil
}
