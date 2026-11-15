// Helpers the reads share: request flags, list filters, files with their
// addresses, decisions in their named form, and who answers for an agent.

package server

import (
	"context"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// truthyParam reports whether a flag parameter is given and on (see truthy).
func truthyParam(v url.Values, name string) bool {
	return v.Has(name) && truthy(v.Get(name))
}

// keep returns, in a new list, the items ok says yes to.
func keep[T any](list []T, ok func(T) bool) []T {
	out := make([]T, 0, len(list))
	for _, v := range list {
		if ok(v) {
			out = append(out, v)
		}
	}
	return out
}

// lines is items as text, one line each, or the line empty when there are none.
func lines[T any](items []T, line func(T) string, empty string) string {
	if len(items) == 0 {
		return empty + "\n"
	}
	var b strings.Builder
	for _, it := range items {
		b.WriteString(line(it) + "\n")
	}
	return b.String()
}

// fileURL is where a file is served, and its reduced copy when it has one.
func (x *c) fileURL(f core.File) (fileAddress, preview string) {
	fileAddress = x.s.cfg.BaseURL + "/f/" + f.ID + "/" + url.PathEscape(f.Name)
	if f.PreviewKey != "" {
		preview = x.s.cfg.BaseURL + "/f/" + f.ID + "/preview"
	}
	return fileAddress, preview
}

// attachments loads the attachments the conditions select (those of a task,
// of a page) with their files: as views by what each is attached to, and as
// rows, each with its file.
func (x *c) attachments(conds ...store.Cond) (map[string][]attachmentView, []core.Attachment, error) {
	var atts []core.Attachment
	if err := x.db.List(x.ctx(), &atts, store.Q{Where: append(conds, store.Live), Order: "rank"}); err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(atts))
	for i, a := range atts {
		ids[i] = a.FileID
	}
	var files []core.File
	if len(ids) > 0 {
		if err := x.db.List(x.ctx(), &files, store.Where(store.In("id", ids))); err != nil {
			return nil, nil, err
		}
	}
	byID := map[string]core.File{}
	for _, f := range files {
		f.URL, f.PreviewURL = x.fileURL(f)
		byID[f.ID] = f
	}
	out := map[string][]attachmentView{}
	for i, a := range atts {
		f := byID[a.FileID]
		atts[i].File = &f
		out[a.SubjectID] = append(out[a.SubjectID], attachmentView{ID: a.ID, Name: f.Name, Type: f.ContentType, Size: f.Size, URL: f.URL,
			Preview: f.PreviewURL, Role: a.Role, Caption: a.Caption})
	}
	return out, atts, nil
}

// decisionViews names decisions, numbering them within their task.
func (x *c) decisionViews(decisions []core.Decision) ([]decisionView, error) {
	run := x.newDecisionViews(decisions)
	return run.build(run.loadOptions)
}

// decisionViewsWithFiles is decisionViews with the files on each question
// and on each option, and with how many comments each option has.
func (x *c) decisionViewsWithFiles(decisions []core.Decision) ([]decisionView, error) {
	run := x.newDecisionViews(decisions)
	return run.build(run.loadOptions, run.loadFiles)
}

// decisionViewsRun is one run of decisionViews: the decisions, then what is
// read for them.
type decisionViewsRun struct {
	x         *c
	decisions []core.Decision
	ids       []string // the decisions' ids, in order
	taskIDs   []string // the tasks they are on, once each
	names     *nameLookup
	options   []core.Option
	files     map[string][]attachmentView // by decision or option id
	comments  map[string]int              // by option id
	keys      map[string]string           // task key by task id
}

func (x *c) newDecisionViews(decisions []core.Decision) *decisionViewsRun {
	run := &decisionViewsRun{x: x, decisions: decisions, ids: make([]string, len(decisions)),
		files: map[string][]attachmentView{}, comments: map[string]int{}, keys: map[string]string{}}
	onTask := map[string]bool{}
	for i, decision := range decisions {
		run.ids[i] = decision.ID
		onTask[decision.TaskID] = true
	}
	for taskID := range onTask {
		run.taskIDs = append(run.taskIDs, taskID)
	}
	return run
}

// build reads the names, then what reads asks for, then the keys of the
// tasks, and makes the views.
func (run *decisionViewsRun) build(reads ...func() error) ([]decisionView, error) {
	if len(run.decisions) == 0 {
		return nil, nil
	}
	steps := append(append([]func() error{run.loadNames}, reads...), run.loadTaskKeys)
	for _, step := range steps {
		if err := step(); err != nil {
			return nil, err
		}
	}
	return run.views(), nil
}

func (run *decisionViewsRun) loadNames() error {
	var err error
	run.names, err = run.x.names()
	return err
}

func (run *decisionViewsRun) loadOptions() error {
	return run.x.db.List(run.x.ctx(), &run.options, store.Q{Where: []store.Cond{store.In("decision_id", run.ids), store.Live}, Order: "rank"})
}

// loadFiles reads the files on the questions and the options, and counts
// the comments on each option.
func (run *decisionViewsRun) loadFiles() error {
	x := run.x
	subjects := append([]string(nil), run.ids...)
	for _, option := range run.options {
		subjects = append(subjects, option.ID)
	}
	var err error
	if run.files, _, err = x.attachments(store.In("subject_id", subjects)); err != nil {
		return err
	}
	counts, err := x.db.Tally(x.ctx(), "comments", []string{"subject_id"}, store.In("task_id", run.taskIDs), store.Eq("subject_type", "decision_option"), store.Live)
	if err != nil {
		return err
	}
	for _, count := range counts {
		run.comments[count.Keys[0]] = count.Count
	}
	return nil
}

func (run *decisionViewsRun) loadTaskKeys() error {
	tasks, err := run.x.db.Tasks(run.x.ctx(), store.TaskFilter{IDs: run.taskIDs, Archived: true, Limit: maxTasksByID})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		run.keys[t.ID] = t.Key
	}
	return nil
}

// views makes the views, numbering each decision within its task and each
// option within its decision.
func (run *decisionViewsRun) views() []decisionView {
	names := run.names
	ordinal := map[string]int{}
	out := make([]decisionView, len(run.decisions))
	for i, d := range run.decisions {
		ordinal[d.TaskID]++
		v := decisionView{N: ordinal[d.TaskID], ID: d.ID, Task: run.keys[d.TaskID], TaskID: d.TaskID, DeletedAt: d.DeletedAt, Kind: d.Kind, Question: d.Question, Details: d.Details, Action: d.Action,
			State: d.State, By: names.handle(d.CreatedBy), Asked: names.handle(d.AskedID), Recommendation: d.Recommendation, Outcome: d.Outcome,
			Note: d.OutcomeNote, DecidedBy: names.handle(d.DecidedBy), DecidedAt: formatTime(d.DecidedAt), UnclearNote: d.UnclearNote, AskedAt: formatTime(d.CreatedAt),
			Attachments: run.files[d.ID]}
		n := 0
		for _, o := range run.options {
			if o.DecisionID != d.ID {
				continue
			}
			n++
			v.Options = append(v.Options, optionView{N: n, ID: o.ID, Label: o.Label, Description: o.Description, Attachments: run.files[o.ID], Comments: run.comments[o.ID]})
			if o.ID == d.RecommendedOptionID {
				v.Recommended = n
			}
			if o.ID == d.PickedOptionID {
				v.Picked, v.PickedLabel = n, o.Label
			}
		}
		out[i] = v
	}
	return out
}

// withResponsible fills in, for each agent, the person who answers for it.
// The lists it fills are shown without that when it cannot be read.
func (s *Server) withResponsible(ctx context.Context, members []core.Member) {
	var ids []string
	for _, m := range members {
		if m.Kind == core.KindAgent {
			ids = append(ids, m.UserID)
		}
	}
	if len(ids) == 0 {
		return
	}
	var users []core.User
	if err := s.st.List(ctx, &users, store.Where(store.In("id", ids))); err != nil {
		s.log.Warn("agents listed without who answers for them", "err", err)
		return
	}
	responsible := map[string]string{}
	for _, user := range users {
		responsible[user.ID] = user.ResponsibleID
	}
	for i := range members {
		members[i].ResponsibleID = responsible[members[i].UserID]
	}
}
