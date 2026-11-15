// The starting copy (/bootstrap): the workspace as rows, for a client that
// keeps a local copy and follows the feed from there.

package server

import (
	"context"
	"maps"
	"net/url"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleBootstrapLocalCopy returns the workspace as rows, for a client that keeps a local
// copy and then follows the feed from "seq".
func (s *Server) handleBootstrapLocalCopy(x *c) error {
	ctx := x.ctx()
	// Read the position first: anything committed after it will also come
	// through the feed, and applying an event twice is harmless.
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	part := x.r.URL.Query().Get("part")
	rows, err := x.startingCopy(ctx, part)
	if err != nil {
		return err
	}
	if part == "rest" {
		rows["seq"], rows["part"] = ws.Seq, part
		return x.ok(rows)
	}
	out := map[string]any{"seq": ws.Seq, "workspace": ws, "me": x.member, "user": x.user, "server_time": time.Now().UnixMilli(), "version": s.cfg.Version}
	maps.Copy(out, rows)
	if part == "open" {
		out["part"] = part
		rest, err := x.db.CountTasks(ctx, x.readable(store.TaskFilter{Archived: true, Closed: true}))
		if err != nil {
			return err
		}
		out["rest"] = rest
	}
	return x.ok(out)
}

// startingCopy reads the rows of the starting copy, each list under its
// name: every kind of row the copy brings (rowKinds) as the viewer may see
// it, and the tasks. part "open" brings the open work, which is what the
// first screen needs; part "rest" brings only what that left out, to be
// asked for in the background: the tasks that are done, canceled or
// archived, with their decisions, relations and files. With no part,
// everything comes at once.
//
// A row that hangs on something the copy does not bring is left out with
// it: a decision or a relation of a task that is not there, a milestone of
// an epic that is not. Each decision comes with its options.
func (who *viewer) startingCopy(ctx context.Context, part string) (map[string]any, error) {
	rows := map[string]any{}
	for _, kind := range rowKinds {
		if kind.copyQuery == nil {
			continue
		}
		list, err := kind.read(ctx, who, kind.copyQuery(who))
		if err != nil {
			return nil, err
		}
		rows[kind.name] = list
	}

	// The tasks of the part asked for, in the order they were made and
	// without their descriptions, which are loaded when a task is opened.
	want := who.readable(store.TaskFilter{Archived: true})
	switch part {
	case "":
	case "open":
		want.Open, want.Archived = true, false
	case "rest":
		want.Closed = true
	default:
		return nil, &engine.Error{Code: engine.CodeInvalid, Field: "part", Message: "unknown part " + part, Allowed: []string{"open", "rest"}}
	}
	tasks, err := who.everyTask(ctx, want)
	if err != nil {
		return nil, err
	}
	brought := map[string]bool{}
	for i := range tasks {
		tasks[i].Description = ""
		brought[tasks[i].ID] = true
	}
	rows["tasks"] = tasks

	// The files on the decisions of those tasks and on their options, so a
	// list can show a decision's pictures without opening its task.
	if rows["attachments"], err = who.decisionFiles(ctx, brought); err != nil {
		return nil, err
	}

	// What hangs on a task or an epic the copy does not bring goes with it.
	var options []core.Option
	if err := who.db.List(ctx, &options, live("rank")); err != nil {
		return nil, err
	}
	optionsOf := map[string][]core.Option{}
	for _, option := range options {
		optionsOf[option.DecisionID] = append(optionsOf[option.DecisionID], option)
	}
	decisions := keep(rows["decisions"].([]core.Decision), func(decision core.Decision) bool { return brought[decision.TaskID] })
	for i := range decisions {
		decisions[i].Options = optionsOf[decisions[i].ID]
	}
	rows["decisions"] = decisions
	rows["relations"] = keep(rows["relations"].([]core.Relation), func(r core.Relation) bool { return brought[r.TaskID] || brought[r.RelatedTaskID] })
	if part == "rest" {
		return map[string]any{"tasks": tasks, "decisions": decisions, "attachments": rows["attachments"], "relations": rows["relations"]}, nil
	}
	epicThere := map[string]bool{}
	for _, epic := range rows["epics"].([]core.Epic) {
		epicThere[epic.ID] = true
	}
	rows["milestones"] = keep(rows["milestones"].([]core.Milestone), func(m core.Milestone) bool { return epicThere[m.EpicID] })
	return rows, nil
}

// decisionFiles reads the files on the decisions of the tasks given and on
// their options, each with where it is served from, relative to the server.
func (who *viewer) decisionFiles(ctx context.Context, tasks map[string]bool) ([]core.Attachment, error) {
	var atts []core.Attachment
	if err := who.db.List(ctx, &atts, store.Q{Where: []store.Cond{store.In("subject_type", []string{"decision", "decision_option"}), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	atts = keep(atts, func(a core.Attachment) bool { return tasks[a.TaskID] })
	if len(atts) == 0 {
		return atts, nil
	}
	ids := make([]string, len(atts))
	for i, a := range atts {
		ids[i] = a.FileID
	}
	var files []core.File
	if err := who.db.List(ctx, &files, store.Where(store.In("id", ids))); err != nil {
		return nil, err
	}
	byID := map[string]core.File{}
	for _, f := range files {
		f.URL = "/f/" + f.ID + "/" + url.PathEscape(f.Name)
		if f.PreviewKey != "" {
			f.PreviewURL = "/f/" + f.ID + "/preview"
		}
		byID[f.ID] = f
	}
	for i := range atts {
		if f, ok := byID[atts[i].FileID]; ok {
			atts[i].File = &f
		}
	}
	return atts, nil
}
