package engine

import (
	"encoding/json"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("property.create", core.RoleMember, propertyCreate)
	register("property.update", core.RoleMember, propertyUpdate)
	register("property.delete", core.RoleMember, propertyDelete)
	register("dbview.create", core.RoleMember, dbviewCreate)
	register("dbview.update", core.RoleMember, dbviewUpdate)
	register("dbview.delete", core.RoleMember, dbviewDelete)
	register("source.create", core.RoleAdmin, sourceCreate)
	register("source.update", core.RoleAdmin, sourceUpdate)
	register("source.delete", core.RoleAdmin, sourceDelete)
}

// PropertyTypes are the kinds of column a database can have.
var PropertyTypes = []string{"text", "number", "select", "multi_select", "date", "checkbox", "url", "member", "relation", "rollup", "formula",
	"created_at", "updated_at", "created_by"}

// DBViewTypes are the ways a database can be shown.
var DBViewTypes = []string{"table", "board", "calendar", "gallery", "timeline", "form"}

// database loads a page that is a database the actor may see.
func (c *cx) database(field, ref string) (core.Doc, error) {
	d, err := c.doc(field, ref)
	if err != nil {
		return d, err
	}
	if d.Kind != core.DocDatabase {
		return d, invalid(field, "%q is a page, not a database", d.Title)
	}
	return d, nil
}

type propertyArgs struct {
	ID       string               `json:"id"`
	Database string               `json:"database"`
	Name     Opt[string]          `json:"name"`
	Type     Opt[string]          `json:"type"`
	Config   Opt[json.RawMessage] `json:"config"` // options of a select, the target of a relation, a formula's text…
	Rank     Opt[string]          `json:"rank"`
}

func propertyCreate(c *cx) error {
	var a propertyArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	d, err := c.database("database", a.Database)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(a.Name.V)
	if name == "" {
		return invalid("name", "a property needs a name")
	}
	if a.Type.V == "" {
		a.Type.V = "text"
	}
	if !contains(PropertyTypes, a.Type.V) {
		return oneOf("type", "property type", a.Type.V, PropertyTypes)
	}
	if n, err := c.tx.Count(c.ctx, "db_properties", store.Eq("database_id", d.ID), store.Eq("name", name), store.Live); err != nil {
		return err
	} else if n > 0 {
		return conflictErr("this database already has a property named %q", name)
	}
	rk := a.Rank.V
	if rk == "" {
		if rk, err = nextRank[core.DBProperty](c, store.Eq("database_id", d.ID)); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	p := core.DBProperty{ID: pid, WorkspaceID: c.ws, DatabaseID: d.ID, Name: name, Type: a.Type.V, Config: a.Config.V, Rank: rk, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, p); err != nil {
		return taken(err, "id", pid)
	}
	c.ref = p.ID
	return c.emitTo(docAudience(d), seq, "property.created", "property", p.ID, "doc", d.ID, d.ProjectID, map[string]any{"row": p})
}

func (c *cx) propertyDoc(ref string) (core.DBProperty, core.Doc, error) {
	p, err := get[core.DBProperty](c, "property", "id", ref)
	if err != nil {
		return p, core.Doc{}, err
	}
	d, err := c.doc("id", p.DatabaseID)
	return p, d, err
}

func propertyUpdate(c *cx) error {
	var a propertyArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pr, d, err := c.propertyDoc(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &pr.Name); err != nil {
		return err
	}
	if a.Type.Set {
		if !contains(PropertyTypes, a.Type.V) {
			return oneOf("type", "property type", a.Type.V, PropertyTypes)
		}
		p.str("type", a.Type, &pr.Type)
	}
	if a.Config.Set && string(a.Config.V) != string(pr.Config) {
		p.set["config"] = a.Config.V
		p.changes["config"] = core.FieldChange{From: pr.Config, To: a.Config.V}
	}
	if err := p.rank(a.Rank, &pr.Rank); err != nil {
		return err
	}
	c.ref = pr.ID
	if p.empty() {
		return nil
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"] = seq
	if _, err := c.tx.Update(c.ctx, "db_properties", p.set, store.Eq("id", pr.ID)); err != nil {
		return err
	}
	return c.emitTo(docAudience(d), seq, "property.updated", "property", pr.ID, "doc", d.ID, d.ProjectID, map[string]any{"id": pr.ID, "changes": p.changes})
}

func propertyDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	pr, d, err := c.propertyDoc(a.ID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "db_properties", map[string]any{"deleted_at": c.at, "updated_seq": seq}, store.Eq("id", pr.ID)); err != nil {
		return err
	}
	c.ref = pr.ID
	return c.emitTo(docAudience(d), seq, "property.deleted", "property", pr.ID, "doc", d.ID, d.ProjectID,
		map[string]any{"id": pr.ID, "changes": map[string]core.FieldChange{"deleted_at": {To: c.at}}})
}

type dbviewArgs struct {
	ID       string               `json:"id"`
	Database string               `json:"database"`
	Name     Opt[string]          `json:"name"`
	Type     Opt[string]          `json:"type"`
	Config   Opt[json.RawMessage] `json:"config"` // filters, sorts, grouping, which properties show
	Rank     Opt[string]          `json:"rank"`
}

func dbviewCreate(c *cx) error {
	var a dbviewArgs
	if err := c.args(&a); err != nil {
		return err
	}
	vid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	d, err := c.database("database", a.Database)
	if err != nil {
		return err
	}
	if a.Type.V == "" {
		a.Type.V = "table"
	}
	if !contains(DBViewTypes, a.Type.V) {
		return oneOf("type", "view type", a.Type.V, DBViewTypes)
	}
	name := strings.TrimSpace(a.Name.V)
	if name == "" {
		name = strings.ToUpper(a.Type.V[:1]) + a.Type.V[1:]
	}
	rk := a.Rank.V
	if rk == "" {
		if rk, err = nextRank[core.DBView](c, store.Eq("database_id", d.ID)); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	v := core.DBView{ID: vid, WorkspaceID: c.ws, DatabaseID: d.ID, Name: name, Type: a.Type.V, Config: a.Config.V, Rank: rk, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, v); err != nil {
		return taken(err, "id", vid)
	}
	c.ref = v.ID
	return c.emitTo(docAudience(d), seq, "dbview.created", "dbview", v.ID, "doc", d.ID, d.ProjectID, map[string]any{"row": v})
}

func (c *cx) dbviewDoc(ref string) (core.DBView, core.Doc, error) {
	v, err := get[core.DBView](c, "view", "id", ref)
	if err != nil {
		return v, core.Doc{}, err
	}
	d, err := c.doc("id", v.DatabaseID)
	return v, d, err
}

func dbviewUpdate(c *cx) error {
	var a dbviewArgs
	if err := c.args(&a); err != nil {
		return err
	}
	v, d, err := c.dbviewDoc(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &v.Name); err != nil {
		return err
	}
	if a.Type.Set {
		if !contains(DBViewTypes, a.Type.V) {
			return oneOf("type", "view type", a.Type.V, DBViewTypes)
		}
		p.str("type", a.Type, &v.Type)
	}
	if a.Config.Set && string(a.Config.V) != string(v.Config) {
		p.set["config"] = a.Config.V
		p.changes["config"] = core.FieldChange{From: v.Config, To: a.Config.V}
	}
	if err := p.rank(a.Rank, &v.Rank); err != nil {
		return err
	}
	c.ref = v.ID
	if p.empty() {
		return nil
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"] = seq
	if _, err := c.tx.Update(c.ctx, "db_views", p.set, store.Eq("id", v.ID)); err != nil {
		return err
	}
	return c.emitTo(docAudience(d), seq, "dbview.updated", "dbview", v.ID, "doc", d.ID, d.ProjectID, map[string]any{"id": v.ID, "changes": p.changes})
}

func dbviewDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	v, d, err := c.dbviewDoc(a.ID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "db_views", map[string]any{"deleted_at": c.at, "updated_seq": seq}, store.Eq("id", v.ID)); err != nil {
		return err
	}
	c.ref = v.ID
	return c.emitTo(docAudience(d), seq, "dbview.deleted", "dbview", v.ID, "doc", d.ID, d.ProjectID,
		map[string]any{"id": v.ID, "changes": map[string]core.FieldChange{"deleted_at": {To: c.at}}})
}

// ---- repository sync ----

type sourceArgs struct {
	ID string `json:"id"`
	// Root is the page the repository's files appear under. Leave it out on
	// create to have one made, named by Title.
	Root   string      `json:"root"`
	Title  string      `json:"title"`
	Repo   Opt[string] `json:"repo"` // a path on the server, or a URL git can clone
	Branch Opt[string] `json:"branch"`
	Subdir Opt[string] `json:"subdir"`
	// Authority says who wins when a file and its page both changed since
	// the last sync: repo (default) or pages.
	Authority Opt[string] `json:"authority"`
	// WriteMode says what happens to page edits: commit (default) pushes
	// them to the branch, propose pushes them to a side branch for review,
	// none leaves the repository alone (pages are read-only).
	WriteMode Opt[string] `json:"write_mode"`
}

var (
	authorities = []string{"repo", "pages"}
	writeModes  = []string{"commit", "propose", "none"}
)

func sourceCreate(c *cx) error {
	var a sourceArgs
	if err := c.args(&a); err != nil {
		return err
	}
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Repo.V) == "" {
		return invalid("repo", "give the repository: a path on the server, or a URL git can clone")
	}
	src := core.DocSource{ID: sid, WorkspaceID: c.ws, Repo: strings.TrimSpace(a.Repo.V), Branch: a.Branch.V, Subdir: strings.Trim(a.Subdir.V, "/"),
		Authority: orStr(a.Authority.V, "repo"), WriteMode: orStr(a.WriteMode.V, "commit"), CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if !contains(authorities, src.Authority) {
		return oneOf("authority", "authority", src.Authority, authorities)
	}
	if !contains(writeModes, src.WriteMode) {
		return oneOf("write_mode", "write mode", src.WriteMode, writeModes)
	}
	if a.Root != "" {
		root, err := c.doc("root", a.Root)
		if err != nil {
			return err
		}
		src.RootDocID = root.ID
	} else {
		title := a.Title
		if title == "" {
			title = strings.TrimSuffix(src.Repo[strings.LastIndexAny(src.Repo, "/:")+1:], ".git")
		}
		if err := c.sub("doc.create", docCreateArgs{Title: title, Icon: "git"}); err != nil {
			return err
		}
		src.RootDocID = c.subRef
	}
	seq := c.tx.NextSeq()
	src.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, src); err != nil {
		return taken(err, "id", sid)
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"source_id": src.ID}, store.Eq("id", src.RootDocID)); err != nil {
		return err
	}
	return c.created(seq, "source", src.ID, "doc", src.RootDocID, "", src)
}

func sourceUpdate(c *cx) error {
	var a sourceArgs
	if err := c.args(&a); err != nil {
		return err
	}
	src, err := get[core.DocSource](c, "source", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("repo", a.Repo, &src.Repo); err != nil {
		return err
	}
	p.str("branch", a.Branch, &src.Branch)
	p.str("subdir", a.Subdir, &src.Subdir)
	if a.Authority.Set {
		if !contains(authorities, a.Authority.V) {
			return oneOf("authority", "authority", a.Authority.V, authorities)
		}
		p.str("authority", a.Authority, &src.Authority)
	}
	if a.WriteMode.Set {
		if !contains(writeModes, a.WriteMode.V) {
			return oneOf("write_mode", "write mode", a.WriteMode.V, writeModes)
		}
		p.str("write_mode", a.WriteMode, &src.WriteMode)
	}
	return c.save(p, "doc_sources", "source", src.ID, "doc", src.RootDocID, "", nil)
}

// sourceDelete stops mirroring a repository. The pages stay as ordinary pages.
func sourceDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	src, err := get[core.DocSource](c, "source", "id", a.ID)
	if err != nil {
		return err
	}
	if _, err := c.tx.Update(c.ctx, "docs", map[string]any{"source_id": "", "source_path": "", "source_hash": ""}, store.Eq("source_id", src.ID)); err != nil {
		return err
	}
	return c.trash("doc_sources", "source", src.ID, "doc", src.RootDocID, "", nil)
}

// rowProps turns a row's values as a caller sends them (by property name or
// id) into what is stored (by property id). A member is stored by id, and a
// select value that is not yet an option becomes one.
func (c *cx) rowProps(databaseID string, given map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	var props []core.DBProperty
	if err := c.tx.List(c.ctx, &props, store.Q{Where: []store.Cond{store.Eq("database_id", databaseID), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	out := map[string]json.RawMessage{}
	for key, raw := range given {
		var p *core.DBProperty
		for i := range props {
			if props[i].ID == key || strings.EqualFold(props[i].Name, key) {
				p = &props[i]
			}
		}
		if p == nil {
			names := make([]string, len(props))
			for i, q := range props {
				names[i] = q.Name
			}
			return nil, &Error{Code: CodeInvalid, Field: "props", Message: "this database has no property " + key, Allowed: names, Nearest: nearest(key, names)}
		}
		if string(raw) == "null" {
			out[p.ID] = raw
			continue
		}
		switch p.Type {
		case "formula", "rollup", "created_at", "updated_at", "created_by":
			return nil, invalid("props", "%q is worked out, not set", p.Name)
		case "number":
			var n float64
			if json.Unmarshal(raw, &n) != nil {
				return nil, invalid("props", "%q takes a number", p.Name)
			}
		case "checkbox":
			var b bool
			if json.Unmarshal(raw, &b) != nil {
				return nil, invalid("props", "%q takes true or false", p.Name)
			}
		case "date":
			var s string
			if json.Unmarshal(raw, &s) != nil || checkDate("props", s) != nil {
				return nil, invalid("props", "%q takes a date, YYYY-MM-DD", p.Name)
			}
		case "member":
			var ref string
			if json.Unmarshal(raw, &ref) != nil {
				return nil, invalid("props", "%q takes a member", p.Name)
			}
			m, err := c.memberRef("props", ref)
			if err != nil {
				return nil, err
			}
			raw, _ = json.Marshal(m.UserID)
		case "select", "multi_select":
			var vals []string
			if p.Type == "select" {
				var one string
				if json.Unmarshal(raw, &one) != nil {
					return nil, invalid("props", "%q takes one option", p.Name)
				}
				vals = []string{one}
			} else if json.Unmarshal(raw, &vals) != nil {
				return nil, invalid("props", "%q takes a list of options", p.Name)
			}
			if err := c.addOptions(p, vals); err != nil {
				return nil, err
			}
		case "relation":
			var ids []string
			if json.Unmarshal(raw, &ids) != nil {
				return nil, invalid("props", "%q takes a list of row ids", p.Name)
			}
		}
		out[p.ID] = raw
	}
	return out, nil
}

var optionColors = []string{"gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"}

// addOptions adds select values that are not options yet.
func (c *cx) addOptions(p *core.DBProperty, vals []string) error {
	var cfg map[string]any
	if len(p.Config) > 0 {
		json.Unmarshal(p.Config, &cfg)
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	opts, _ := cfg["options"].([]any)
	added := false
	for _, v := range vals {
		known := v == ""
		for _, o := range opts {
			if om, ok := o.(map[string]any); ok && om["name"] == v {
				known = true
			}
		}
		if !known {
			opts = append(opts, map[string]any{"name": v, "color": optionColors[len(opts)%len(optionColors)]})
			added = true
		}
	}
	if !added {
		return nil
	}
	cfg["options"] = opts
	raw, _ := json.Marshal(cfg)
	old := p.Config
	p.Config = raw
	var d core.Doc
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", p.DatabaseID)); err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "db_properties", map[string]any{"config": json.RawMessage(raw), "updated_seq": seq}, store.Eq("id", p.ID)); err != nil {
		return err
	}
	return c.emitTo(docAudience(d), seq, "property.updated", "property", p.ID, "doc", d.ID, d.ProjectID,
		map[string]any{"id": p.ID, "changes": map[string]core.FieldChange{"config": {From: old, To: json.RawMessage(raw)}}})
}
