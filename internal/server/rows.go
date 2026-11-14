package server

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/formula"
	"github.com/agrigoryan/quadit/internal/store"
)

// table is a database loaded for reading: its columns and its rows.
type table struct {
	doc    core.Doc
	props  []core.DBProperty
	rows   []core.Doc
	values map[string]map[string]any // row id -> property id -> stored value
}

func (x *c) loadTable(d core.Doc) (*table, error) {
	t := &table{doc: d, values: map[string]map[string]any{}}
	if err := x.db.List(x.ctx(), &t.props, store.Q{Where: []store.Cond{store.Eq("database_id", d.ID), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	if err := x.db.List(x.ctx(), &t.rows, store.Q{Where: []store.Cond{store.Eq("parent_id", d.ID), store.Eq("kind", core.DocRow), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	for _, r := range t.rows {
		vals := map[string]any{}
		if len(r.Props) > 0 {
			json.Unmarshal(r.Props, &vals)
		}
		t.values[r.ID] = vals
	}
	return t, nil
}

// propConfig is what a property's config may hold, by type.
type propConfig struct {
	Formula  string `json:"formula"`  // formula
	Database string `json:"database"` // relation: the database it points into
	Relation string `json:"relation"` // rollup: the relation property to follow
	Target   string `json:"target"`   // rollup: the property to read there
	Fn       string `json:"fn"`       // rollup: count, sum, avg, min, max, percent_checked, values
}

// computed works out every cell of a database: stored values as they are,
// and formulas, rollups and the built-in columns from them.
func (x *c) computed(t *table) (map[string]map[string]any, error) {
	nm, err := x.names()
	if err != nil {
		return nil, err
	}
	byName := map[string]core.DBProperty{}
	for _, p := range t.props {
		byName[strings.ToLower(p.Name)] = p
	}
	related := map[string]*table{} // other databases, loaded when a relation needs them
	other := func(dbID string) *table {
		if dbID == t.doc.ID {
			return t
		}
		if rt, ok := related[dbID]; ok {
			return rt
		}
		var d core.Doc
		var rt *table
		if x.db.Get(x.ctx(), &d, store.Eq("id", dbID), store.Live) == nil && engine.CanSeeDoc(d, x.member.UserID) {
			rt, _ = x.loadTable(d)
		}
		related[dbID] = rt
		return rt
	}
	titles := func(dbID string, ids any) []any {
		rt := other(dbID)
		list, _ := ids.([]any)
		var out []any
		for _, rid := range list {
			if rt == nil {
				continue
			}
			for _, r := range rt.rows {
				if r.ID == rid {
					out = append(out, r.Title)
				}
			}
		}
		return out
	}
	out := map[string]map[string]any{}
	var cell func(row core.Doc, p core.DBProperty, depth int) any
	cell = func(row core.Doc, p core.DBProperty, depth int) any {
		var cfg propConfig
		json.Unmarshal(p.Config, &cfg)
		stored := t.values[row.ID][p.ID]
		switch p.Type {
		case "created_at":
			return time.UnixMilli(row.CreatedAt).UTC().Format("2006-01-02 15:04")
		case "updated_at":
			return time.UnixMilli(row.UpdatedAt).UTC().Format("2006-01-02 15:04")
		case "created_by":
			return nm.handle(row.CreatedBy)
		case "member":
			if s, ok := stored.(string); ok {
				return nm.handle(s)
			}
			return nil
		case "formula":
			if depth > 8 {
				return "#loop"
			}
			v, err := formula.Eval(cfg.Formula, formula.Env{Prop: func(name string) any {
				if strings.EqualFold(name, "title") || strings.EqualFold(name, "name") {
					if _, isProp := byName[strings.ToLower(name)]; !isProp {
						return row.Title
					}
				}
				q, ok := byName[strings.ToLower(name)]
				if !ok {
					return nil
				}
				v := cell(row, q, depth+1)
				if q.Type == "relation" {
					var qc propConfig
					json.Unmarshal(q.Config, &qc)
					return titles(qc.Database, v)
				}
				return v
			}})
			if err != nil {
				return "#error: " + err.Error()
			}
			return v
		case "rollup":
			var rel core.DBProperty
			for _, q := range t.props {
				if q.ID == cfg.Relation || strings.EqualFold(q.Name, cfg.Relation) {
					rel = q
				}
			}
			var relCfg propConfig
			json.Unmarshal(rel.Config, &relCfg)
			rt := other(relCfg.Database)
			ids, _ := t.values[row.ID][rel.ID].([]any)
			if rt == nil {
				return nil
			}
			var target core.DBProperty
			for _, q := range rt.props {
				if q.ID == cfg.Target || strings.EqualFold(q.Name, cfg.Target) {
					target = q
				}
			}
			var vals []any
			for _, rid := range ids {
				for _, r := range rt.rows {
					if r.ID != rid {
						continue
					}
					if target.ID == "" {
						vals = append(vals, r.Title)
					} else if v := rt.values[r.ID][target.ID]; v != nil {
						vals = append(vals, v)
					}
				}
			}
			return rollup(cfg.Fn, vals, len(ids))
		}
		return stored
	}
	for _, r := range t.rows {
		cells := map[string]any{}
		for _, p := range t.props {
			if v := cell(r, p, 0); v != nil {
				cells[p.ID] = v
			}
		}
		out[r.ID] = cells
	}
	return out, nil
}

func rollup(fn string, vals []any, related int) any {
	nums := func() []float64 {
		var out []float64
		for _, v := range vals {
			switch n := v.(type) {
			case float64:
				out = append(out, n)
			case bool:
				if n {
					out = append(out, 1)
				} else {
					out = append(out, 0)
				}
			}
		}
		return out
	}
	switch fn {
	case "", "count":
		return float64(related)
	case "values":
		return vals
	case "sum", "avg", "min", "max":
		ns := nums()
		if len(ns) == 0 {
			return nil
		}
		acc := ns[0]
		for _, n := range ns[1:] {
			switch fn {
			case "min":
				acc = min(acc, n)
			case "max":
				acc = max(acc, n)
			default:
				acc += n
			}
		}
		if fn == "avg" {
			acc /= float64(len(ns))
		}
		return acc
	case "percent_checked":
		if related == 0 {
			return nil
		}
		checked := 0
		for _, v := range vals {
			if b, _ := v.(bool); b {
				checked++
			}
		}
		return float64(checked) * 100 / float64(related)
	}
	return nil
}

// rowFilter is one condition of a database view, or of a rows query.
type rowFilter struct {
	Prop  string `json:"prop"` // a property's name or id; "title" is the row's title
	Op    string `json:"op"`   // is, is_not, contains, gt, lt, empty, not_empty, checked, unchecked
	Value any    `json:"value"`
}

type rowSort struct {
	Prop string `json:"prop"`
	Desc bool   `json:"desc"`
}

func matchRow(f rowFilter, v any) bool {
	text := strings.ToLower(formula.Text(v))
	want := strings.ToLower(formula.Text(f.Value))
	switch f.Op {
	case "", "is":
		if list, ok := v.([]any); ok {
			for _, e := range list {
				if strings.ToLower(formula.Text(e)) == want {
					return true
				}
			}
			return false
		}
		return text == want
	case "is_not":
		return !matchRow(rowFilter{Op: "is", Value: f.Value}, v)
	case "contains":
		return strings.Contains(text, want)
	case "empty":
		return text == ""
	case "not_empty":
		return text != ""
	case "checked":
		b, _ := v.(bool)
		return b
	case "unchecked":
		b, _ := v.(bool)
		return !b
	case "gt", "lt":
		a, aok := v.(float64)
		b, bok := f.Value.(float64)
		if !aok || !bok {
			if f.Op == "gt" {
				return text > want
			}
			return text < want && text != ""
		}
		if f.Op == "gt" {
			return a > b
		}
		return a < b
	}
	return true
}

// hRows returns a database's rows with every cell worked out, by property
// name. view=NAME applies a saved view's filters and sorts; filter and sort
// in the URL do the same for one query: filter=Status:is:Done,Points:gt:3.
func (s *Server) hRows(x *c) error {
	d, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	if d.Kind != core.DocDatabase {
		return errBad("%q is a page, not a database", d.Title)
	}
	t, err := x.loadTable(d)
	if err != nil {
		return err
	}
	cells, err := x.computed(t)
	if err != nil {
		return err
	}
	prop := func(ref string) (core.DBProperty, bool) {
		for _, p := range t.props {
			if p.ID == ref || strings.EqualFold(p.Name, ref) {
				return p, true
			}
		}
		return core.DBProperty{}, false
	}
	var cfg struct {
		Filters []rowFilter `json:"filters"`
		Sorts   []rowSort   `json:"sorts"`
	}
	v := x.r.URL.Query()
	if name := v.Get("view"); name != "" {
		var views []core.DBView
		if err := x.db.List(x.ctx(), &views, store.Where(store.Eq("database_id", d.ID), store.Live)); err != nil {
			return err
		}
		found := false
		var names []string
		for _, dv := range views {
			names = append(names, dv.Name)
			if dv.ID == name || strings.EqualFold(dv.Name, name) {
				json.Unmarshal(dv.Config, &cfg)
				found = true
			}
		}
		if !found {
			return &engine.Error{Code: engine.CodeNotFound, Field: "view", Message: "no view " + name, Allowed: names, Nearest: nearestOf(name, names)}
		}
	}
	for _, part := range splitList(v.Get("filter")) {
		bits := strings.SplitN(part, ":", 3)
		f := rowFilter{Prop: bits[0], Op: "not_empty"}
		if len(bits) > 1 {
			f.Op = bits[1]
		}
		if len(bits) > 2 {
			f.Value = bits[2]
			var n float64
			if _, err := fmt.Sscanf(bits[2], "%g", &n); err == nil && fmt.Sprint(n) == bits[2] {
				f.Value = n
			}
		}
		cfg.Filters = append(cfg.Filters, f)
	}
	for _, part := range splitList(v.Get("sort")) {
		cfg.Sorts = append(cfg.Sorts, rowSort{Prop: strings.TrimPrefix(part, "-"), Desc: strings.HasPrefix(part, "-")})
	}
	value := func(r core.Doc, ref string) (any, error) {
		if strings.EqualFold(ref, "title") {
			if _, isProp := prop(ref); !isProp {
				return r.Title, nil
			}
		}
		p, ok := prop(ref)
		if !ok {
			var names []string
			for _, q := range t.props {
				names = append(names, q.Name)
			}
			return nil, &engine.Error{Code: engine.CodeInvalid, Field: "prop", Message: "no property " + ref, Allowed: append(names, "title"), Nearest: nearestOf(ref, names)}
		}
		return cells[r.ID][p.ID], nil
	}
	rows := t.rows
	for _, f := range cfg.Filters {
		var kept []core.Doc
		for _, r := range rows {
			val, err := value(r, f.Prop)
			if err != nil {
				return err
			}
			if matchRow(f, val) {
				kept = append(kept, r)
			}
		}
		rows = kept
	}
	for i := len(cfg.Sorts) - 1; i >= 0; i-- {
		so := cfg.Sorts[i]
		if _, err := value(core.Doc{}, so.Prop); err != nil {
			return err
		}
		sort.SliceStable(rows, func(a, b int) bool {
			va, _ := value(rows[a], so.Prop)
			vb, _ := value(rows[b], so.Prop)
			fa, aNum := va.(float64)
			fb, bNum := vb.(float64)
			less := formula.Text(va) < formula.Text(vb)
			if aNum && bNum {
				less = fa < fb
			}
			if so.Desc {
				return !less && formula.Text(va) != formula.Text(vb)
			}
			return less
		})
	}
	type rowOut struct {
		ID     string         `json:"id"`
		Title  string         `json:"title"`
		Values map[string]any `json:"values"`
	}
	out := make([]rowOut, len(rows))
	for i, r := range rows {
		vals := map[string]any{}
		for _, p := range t.props {
			if cv, ok := cells[r.ID][p.ID]; ok {
				vals[p.Name] = cv
			}
		}
		out[i] = rowOut{ID: r.ID, Title: r.Title, Values: vals}
	}
	if truthyParam(v, "raw") {
		return x.ok(map[string]any{"computed": cells})
	}
	if x.wantText() {
		var b strings.Builder
		b.WriteString("| Title |")
		for _, p := range t.props {
			b.WriteString(" " + p.Name + " |")
		}
		b.WriteString("\n|" + strings.Repeat(" --- |", len(t.props)+1) + "\n")
		for _, r := range out {
			b.WriteString("| " + oneLine(r.Title, 60) + " |")
			for _, p := range t.props {
				b.WriteString(" " + strings.ReplaceAll(oneLine(formula.Text(r.Values[p.Name]), 60), "|", "/") + " |")
			}
			b.WriteString("  (" + r.ID + ")\n")
		}
		return x.text(b.String())
	}
	props := make([]map[string]string, len(t.props))
	for i, p := range t.props {
		props[i] = map[string]string{"name": p.Name, "type": p.Type, "id": p.ID}
	}
	return x.ok(map[string]any{"database": d.Title, "properties": props, "rows": out})
}
